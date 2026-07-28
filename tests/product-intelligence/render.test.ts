import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderBrief } from '../../skills/product-intelligence/scripts/render.ts';

const repoRoot = dirname(dirname(import.meta.dir));
const skillRoot = join(repoRoot, 'skills', 'product-intelligence');
const mixed = join(skillRoot, 'examples', 'mixed');

let scratch = '';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'agentkit-render-'));
});
afterEach(() => {
  rmSync(scratch, { force: true, recursive: true });
});

describe('renderBrief', () => {
  const page = () => renderBrief(mixed);

  test('every ledger claim is anchored and every citation links to one', () => {
    const out = page();
    const ledger = readFileSync(join(mixed, 'ledger.yaml'), 'utf-8');
    for (const id of ledger.match(/C-\d{3}/g) ?? []) {
      expect(out, id).toContain(`id="${id.toLowerCase()}"`);
    }
    for (const ref of out.match(/href="#(c-\d{3})"/g) ?? []) {
      const id = ref.match(/#(c-\d{3})/)![1];
      expect(out, ref).toContain(`id="${id}"`);
    }
  });

  test('positioning renders as a sentence, not yaml slots', () => {
    const out = page();
    expect(out).toContain('**For** solo developers **who need**');
    expect(out).toContain('**Unlike** hosted note SaaS');
    expect(out).not.toContain('target_customer');
  });

  function withArtifacts(brief: string, ledger?: string): string {
    writeFileSync(join(scratch, 'brief.yaml'), brief);
    writeFileSync(
      join(scratch, 'ledger.yaml'),
      ledger ?? readFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'ledger.yaml'), 'utf-8'),
    );
    return renderBrief(scratch);
  }

  const minimalBrief = (extra: string) =>
    ["brief_version: '1.0'", 'subject: { name: acme }', 'evidence: { ledger: ledger.yaml }', extra].join('\n');

  const journalBrief = () => minimalBrief('positioning: { category: journal }');

  function ledgerWith(...claims: string[][]): string {
    const head = ["ledger_version: '1.0'", 'generated_by: t', "generated_at: '2026-07-28'", 'claims:'];
    return [...head, ...claims.flat()].join('\n');
  }

  const claim = (id: string, statement: string, cls: string, confidence: string, sources: string[][] = []) => [
    `  - id: ${id}`,
    `    statement: ${JSON.stringify(statement)}`,
    `    class: ${cls}`,
    `    confidence: ${confidence}`,
    ...(sources.length ? ['    sources:', ...sources.flat()] : []),
  ];

  const src = (locator: string, quote: string, stance: string) => [
    `      - locator: ${JSON.stringify(locator)}`,
    `        quote: ${JSON.stringify(quote)}`,
    `        stance: ${stance}`,
    "        as_of: '2026-07-28'",
  ];

  test('hostile quotes and fields cannot inject markup into the page', () => {
    // Quotes are verbatim excerpts from crawled sources; the published page's
    // CSP permits inline script, so raw interpolation would be stored XSS.
    const out = withArtifacts(
      minimalBrief('positioning: { category: "<img src=x onerror=alert(1)>" }'),
      ledgerWith(claim('C-001', '<script>alert(1)</script>', 'observed', 'high', [
        src('site:/<script>x</script>', '</blockquote><script>alert(1)</script>', 'supports'),
      ])),
    );
    // Escaped text may still read "onerror=" — what matters is that no tag
    // can form, so the browser sees inert text.
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;img');
  });

  test('a multi-line quote stays inside its blockquote', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'multi-line source', 'observed', 'high', [
        src('site:/x', 'line one\n## Injected Heading\nline three', 'supports'),
      ])),
    );
    // The heading markers are escaped so the quote renders verbatim instead
    // of forming a heading inside the blockquote.
    for (const line of ['line one', '\\#\\# Injected Heading', 'line three']) {
      expect(out, line).toContain(`> ${line}`);
    }
    expect(out).not.toMatch(/^## Injected Heading/m);
    expect(out).not.toMatch(/> ## Injected Heading/);
  });

  test('markdown in a quote is neutralised: no live links, characters kept', () => {
    // esc() alone would leave markdown active: a schema-valid quote could
    // render as <a href="javascript:...">, and emphasis would eat the very
    // characters the verbatim promise guarantees.
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'markdown quote', 'observed', 'high', [
        src('site:/pricing', 'Free plan: [claim your *free* seat](javascript:fetch(1))', 'supports'),
        src('site:/terms', 'Pay *only* $5 for 2*3 items -- see `config.yaml`', 'supports'),
      ])),
    );
    expect(out).not.toContain('](javascript:');
    expect(out).toContain('\\[claim your \\*free\\* seat\\]\\(javascript:fetch\\(1\\)\\)');
    expect(out).toContain('\\*only\\* $5 for 2\\*3 items -- see \\`config.yaml\\`');
  });

  // One payload per untrusted field: a sampled test lets a refactor reopen
  // the injection on every field it does not sample. Each field carries a
  // distinct marker so a surviving escape gap names itself.
  const FIELDS = [
    'name', 'one_liner', 'category', 'target_customer', 'need', 'key_benefit',
    'alternative', 'differentiation', 'vm_attribute', 'vm_value', 'vm_proof',
    'js_situation', 'js_motivation', 'js_outcome', 'wf_name', 'wf_step',
    'wf_description', 'si_locator', 'si_title', 'si_page_type', 'si_disposition',
    'si_rationale', 'cv_what', 'cv_why', 'statement', 'quote', 'locator',
    'acq_tool', 'acq_target',
  ] as const;

  // The marker itself must survive escaping unchanged, so it carries no
  // markdown metacharacter of its own.
  const marker = (field: string) => field.replace(/_/g, '');
  const payload = (field: string) =>
    `<script>${marker(field)}</script>[x](javascript:alert(1))\n\n## forged ${marker(field)}`;

  test('no untrusted field can inject markup, links or headings', () => {
    const y = (v: string) => JSON.stringify(payload(v));
    const brief = [
      "brief_version: '1.0'",
      `subject: { name: ${y('name')}, one_liner: ${y('one_liner')} }`,
      'evidence:',
      '  ledger: ledger.yaml',
      '  acquisition:',
      `    - tool: ${y('acq_tool')}`,
      `      target: ${y('acq_target')}`,
      "      retrieved_at: '2026-07-28'",
      'positioning:',
      ...(['category', 'target_customer', 'need', 'key_benefit', 'alternative', 'differentiation'] as const)
        .map((k) => `  ${k}: ${y(k)}`),
      'value_map:',
      `  - attribute: ${y('vm_attribute')}`,
      `    value: ${y('vm_value')}`,
      `    proof: ${y('vm_proof')}`,
      'job_stories:',
      `  - situation: ${y('js_situation')}`,
      `    motivation: ${y('js_motivation')}`,
      `    outcome: ${y('js_outcome')}`,
      'workflows:',
      `  - name: ${y('wf_name')}`,
      '    steps:',
      `      - step: ${y('wf_step')}`,
      `        description: ${y('wf_description')}`,
      'site_inventory:',
      `  - locator: ${y('si_locator')}`,
      `    title: ${y('si_title')}`,
      `    page_type: ${y('si_page_type')}`,
      `    disposition: ${y('si_disposition')}`,
      `    rationale: ${y('si_rationale')}`,
      'cannot_verify:',
      `  - what: ${y('cv_what')}`,
      `    why: ${y('cv_why')}`,
    ].join('\n');
    const out = withArtifacts(
      brief,
      ledgerWith(claim('C-001', payload('statement'), 'observed', 'high', [
        src(payload('locator'), payload('quote'), 'supports'),
      ])),
    );

    expect(out).not.toContain('<script');
    expect(out).not.toContain('](javascript:');
    // A forged heading needs a line start; every field is newline-collapsed.
    expect(out).not.toMatch(/^#+ forged/m);
    for (const field of FIELDS) {
      expect(out, `${field} unescaped`).not.toContain(`<script>${marker(field)}`);
      expect(out, `${field} missing`).toContain(`&lt;script&gt;${marker(field)}`);
    }
  });

  // The full-slot fixture above never reaches the chips, the citation
  // anchors, the single-slot positioning fallbacks or the contradiction rows.
  test('metadata, citations and fallback branches are escaped too', () => {
    const p = (m: string) => JSON.stringify(payload(m));
    const out = withArtifacts(
      [
        "brief_version: '1.0'",
        'subject:',
        `  name: ${p('subjname')}`,
        `  repo: ${p('repo')}`,
        `  homepage: ${p('homepage')}`,
        '  origins:',
        `    - { id: ${p('originone')} }`,
        `    - { id: ${p('origintwo')} }`,
        'evidence:',
        '  ledger: ledger.yaml',
        `  acquired_at: ${p('acquiredat')}`,
        `positioning: { alternative: ${p('altonly')} }`,
        'value_map:',
        '  - attribute: a',
        '    value: v',
        `    claims: [${p('citation')}]`,
      ].join('\n'),
      ledgerWith(
        [
          ...claim('C-001', payload('stmtone'), 'observed', 'high', [
            src('site:/a', 'q', 'supports'),
          ]),
          '    contradicts: [C-002]',
        ],
        claim('C-002', payload('stmttwo'), 'observed', 'high'),
      ),
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('](javascript:');
    expect(out).not.toMatch(/^#+ forged/m);
    for (const m of [
      'subjname', 'repo', 'homepage', 'originone', 'origintwo', 'acquiredat',
      'altonly', 'citation', 'stmtone', 'stmttwo',
    ]) {
      expect(out, `${m} unescaped`).not.toContain(`<script>${m}`);
      expect(out, `${m} missing`).toContain(`&lt;script&gt;${m}`);
    }
    // The citation reaches both the anchor target and its label.
    expect(out).toContain(String.raw`href="#&lt;script&gt;citation&lt;/script&gt;&#91;`);
  });

  // renderBrief validates nothing, so schema-constrained metadata still
  // arrives untrusted when the caller skips validate.ts.
  test('unvalidated ledger metadata cannot inject either', () => {
    const out = withArtifacts(
      [
        "brief_version: '1.0'",
        'subject: { name: acme }',
        'evidence:',
        '  ledger: ledger.yaml',
        '  acquisition:',
        '    - tool: t',
        '      target: g',
        `      retrieved_at: ${JSON.stringify(payload('retrievedat'))}`,
      ].join('\n'),
      [
        "ledger_version: '1.0'",
        'generated_by: t',
        "generated_at: '2026-07-28'",
        'claims:',
        `  - id: ${JSON.stringify(payload('claimid'))}`,
        '    statement: s',
        `    class: ${JSON.stringify(payload('claimclass'))}`,
        `    confidence: ${JSON.stringify(payload('confidence'))}`,
        '    sources:',
        '      - locator: site:/a',
        '        quote: q',
        `        stance: ${JSON.stringify(payload('stance'))}`,
        `        as_of: ${JSON.stringify(payload('asof'))}`,
        '  - id: C-002',
        '    statement: sourceless',
        `    class: ${JSON.stringify(payload('nosrcclass'))}`,
        '    confidence: low',
      ].join('\n'),
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('](javascript:');
    expect(out).not.toMatch(/^#+ forged/m);
    for (const m of ['retrievedat', 'claimid', 'claimclass', 'confidence', 'stance', 'asof', 'nosrcclass']) {
      expect(out, `${m} unescaped`).not.toContain(`<script>${m}`);
      expect(out, `${m} missing`).toContain(`&lt;script&gt;${m}`);
    }
  });

  test('single-slot positioning fallbacks escape their one field', () => {
    for (const slot of ['need', 'target_customer', 'differentiation'] as const) {
      const out = withArtifacts(
        minimalBrief(`positioning: { ${slot}: ${JSON.stringify(payload(slot))} }`),
      );
      expect(out, slot).not.toContain('<script');
      expect(out, slot).toContain(`&lt;script&gt;${marker(slot)}`);
    }
  });

  test('a backtick in a locator cannot break its code element', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'hostile locator', 'observed', 'high', [
        src('repo:READ`ME.md', 'quote', 'supports'),
      ])),
    );
    expect(out).toContain('<code>repo:READ\\`ME.md</code>');
  });

  test('a dangling or self-referential contradiction is dropped, not rendered broken', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(
        [...claim('C-001', 'real', 'observed', 'high'), '    contradicts: [C-999, C-001]'],
        claim('C-002', 'other', 'observed', 'high'),
      ),
    );
    expect(out).not.toContain('## Unresolved contradictions');
    expect(out).not.toContain('****');
    expect(out).not.toContain('href="#c-999"');
  });

  test('a pipe in free text cannot split a table row', () => {
    const out = withArtifacts(
      minimalBrief([
        'workflows:',
        '  - name: flow',
        '    steps:',
        '      - step: run',
        '        description: "a | b"',
      ].join('\n')),
    );
    expect(out).toContain('a &#124; b');
    expect(out).not.toContain('| a | b |');
  });

  test('raw HTML in findings.md is inert, fenced code is untouched', () => {
    // findings.md quotes crawled sources, so a payload copied into it must
    // not execute on the published page.
    writeFileSync(
      join(scratch, 'findings.md'),
      [
        '# Findings',
        '',
        '## Contradictions',
        '',
        '<script>alert(1)</script>',
        '',
        '```html',
        '<kbd>fence stays raw</kbd>',
        '```',
      ].join('\n'),
    );
    const out = withArtifacts(journalBrief());
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script>');
    expect(out).toContain('<kbd>fence stays raw</kbd>');
  });

  test('active link schemes in findings.md are defused', () => {
    writeFileSync(
      join(scratch, 'findings.md'),
      [
        '# Findings',
        '',
        'See [pricing](https://example.com/pricing) and [click](javascript:fetch(1)).',
        '',
        '[r]: javascript:alert(1)',
      ].join('\n'),
    );
    const out = withArtifacts(journalBrief());
    expect(out).not.toContain('](javascript:');
    expect(out).toContain(']\\(javascript:');
    expect(out).toContain('\\[r]: javascript:');
    // Ordinary links keep working.
    expect(out).toContain('[pricing](https://example.com/pricing)');
  });

  test('contradictions get their own section and per-claim markers', () => {
    const out = page();
    expect(out).toContain('## Unresolved contradictions');
    expect(out).toContain('Recorded, not reconciled');
    expect(out).toContain('contradicts <a href="#c-002">C-002</a>');
    // One row per pair, not one per direction.
    expect(out.match(/Both sources are recorded/g)).toHaveLength(1);
  });

  test('source stance is never flattened — a refuting source says so', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'contested', 'observed', 'low', [
        src('site:/a', 'yes', 'refutes'),
        src('site:/b', 'maybe', 'context'),
      ])),
    );
    expect(out).toContain('**refutes**');
    expect(out).toContain('context only');
    // Both sources of a multi-source claim render.
    expect(out).toContain('> yes');
    expect(out).toContain('> maybe');
  });

  test('workflows render instead of vanishing', () => {
    const out = page();
    expect(out).toContain('## Where it sits in the work');
    expect(out).toContain('capture a finding');
    expect(out).toContain('<code>execute</code>');
  });

  test('class, confidence and derived_from all reach the evidence section', () => {
    const out = page();
    expect(out).toContain('<strong>inferred</strong> moderate');
    expect(out).toContain('inferred from <a href="#c-001">C-001</a>');
  });

  test('a sourceless proposed claim says so instead of showing an empty quote', () => {
    const out = page();
    expect(out).toContain('this claim is proposed');
    expect(out).not.toMatch(/\n> \n/);
  });

  test('partial positioning never renders a dangling fragment', () => {
    for (const [slots, expected] of [
      ['positioning: { target_customer: solo devs, need: notes near code }', '**For** solo devs **who need** notes near code, **acme**.'],
      ['positioning: { key_benefit: versioned notes }', '**acme** that delivers versioned notes.'],
      ['positioning: { alternative: paper logs }', 'measured against: paper logs.'],
      ['positioning: { differentiation: git-native }', 'What sets it apart: git-native.'],
    ] as const) {
      const out = withArtifacts(minimalBrief(slots));
      expect(out, slots).toContain(expected);
      expect(out, slots).not.toMatch(/,\n/);
    }
  });

  test('job stories do not double the template verbs', () => {
    const out = page();
    expect(out).not.toContain('I want I want');
    expect(out).not.toContain('so I can I can');
    expect(out).toContain('**so that**');
  });

  test('the how-to-read promise matches what the claims actually carry', () => {
    const sourceless = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'someday', 'proposed', 'low')),
    );
    expect(sourceless).not.toContain('carries a verbatim quote');
    expect(page()).toContain('carries a verbatim quote');
  });

  test('site inventory keeps the page title', () => {
    expect(page()).toContain('Plans');
  });

  test('a missing ledger fails with a clear message, not a stack', () => {
    writeFileSync(join(scratch, 'brief.yaml'), journalBrief());
    expect(() => renderBrief(scratch)).toThrow('render needs both');
  });

  test('verbatim ledger quotes appear in the evidence section', () => {
    const out = page();
    expect(out).toContain('> Free — up to 3 projects');
    expect(out).toContain('— supports, <code>site:/pricing\\#plans</code>, as of 2026-07-27');
  });

  test('findings are folded in with downgraded headings', () => {
    const out = page();
    expect(out).toContain('## What the analyze pass flagged');
    expect(out).toContain('### Contradictions');
    expect(out).not.toContain('\n## Contradictions');
  });

  test('a minimal brief renders without the optional sections', () => {
    copyFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'brief.minimal.yaml'), join(scratch, 'brief.yaml'));
    copyFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'ledger.yaml'), join(scratch, 'ledger.yaml'));
    const out = renderBrief(scratch);
    expect(out).toContain('# acme-notes: what the evidence says');
    expect(out).not.toContain('## What it is');
    expect(out).not.toContain('## What that gets you');
    expect(out).toContain('## The evidence, claim by claim');
  });

  test('category article adapts: an evidence ledger, a journal', () => {
    copyFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'ledger.yaml'), join(scratch, 'ledger.yaml'));
    writeFileSync(
      join(scratch, 'brief.yaml'),
      [
        "brief_version: '1.0'",
        'subject: { name: x }',
        'evidence: { ledger: ledger.yaml }',
        'positioning: { category: evidence toolkit }',
      ].join('\n'),
    );
    expect(renderBrief(scratch)).toContain('is an evidence toolkit');
  });
});

describe('render.ts CLI', () => {
  test('writes brief-page.md into the intelligence dir by default', () => {
    const script = join(skillRoot, 'scripts', 'render.ts');
    for (const f of ['brief.yaml', 'ledger.yaml', 'brief.md', 'findings.md']) {
      copyFileSync(join(mixed, f), join(scratch, f));
    }
    const result = spawnSync('bun', [script, scratch], { encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(scratch, 'brief-page.md'), 'utf-8')).toContain('acme-notes: what the evidence says');
  });
});
