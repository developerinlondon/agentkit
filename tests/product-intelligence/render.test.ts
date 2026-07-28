import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderBrief } from '../../skills/product-intelligence/scripts/render.ts';
import {
  claim,
  FIELDS,
  hostileBrief,
  hostileLedger,
  journalBrief,
  ledgerWith,
  marker,
  minimalBrief,
  payload,
  src,
} from './fixtures.ts';

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

  test('no untrusted field can inject markup, links or headings', () => {
    const out = withArtifacts(hostileBrief(), hostileLedger());

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

  // The suite asserted payloads stay inert but never that ordinary text
  // survives, so a double-encoding regression shipped green: an apostrophe
  // reached the reader as its own entity text.
  test('benign punctuation reaches the reader unchanged', () => {
    const out = withArtifacts(
      [
        "brief_version: '1.0'",
        `subject: { name: acme, homepage: "https://team.example/it's-here" }`,
        'evidence: { ledger: ledger.yaml }',
        'value_map:',
        `  - attribute: "keeps your team's notes in git"`,
        `    value: "they're yours & they outlive it"`,
        `    proof: "read the team's notes | in any editor"`,
      ].join('\n'),
      ledgerWith(claim('C-001', "it's fine", 'observed', 'high')),
    );
    expect(out).not.toContain('&&#35;');
    expect(out).not.toContain('&#38;#');
    for (const shown of ["team&#39;s", "they&#39;re", "it&#39;s-here", '&#124;']) {
      expect(out, shown).toContain(shown);
    }
    // Each entity appears once — never wrapped in a second encoding.
    expect(out).not.toMatch(/&#\d+;\d/);
  });

  test('a multi-line quote keeps its line structure', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'tiers', 'observed', 'high', [
        src('site:/p', 'Tiers:\n- Free — up to 5 projects\n- Pro — $5/mo', 'supports'),
      ])),
    );
    // A break on every line but the last: consecutive blockquote lines would
    // otherwise reflow into one run-on paragraph.
    expect(out).toContain('> Tiers:<br />');
    expect(out).toContain('\\- Free — up to 5 projects<br />');
    expect(out).toContain('\\- Pro — $5/mo\n');
    expect(out).not.toContain('$5/mo<br />');
  });

  // marked's whole GFM autolink surface: http/https/ftp case-insensitively,
  // lowercase www., and an email whose local part may end in a dot. Every
  // untrusted field must defuse all of them, whichever escaper it uses — the
  // badge reaches inline-HTML context, where the inline lexer still runs.
  const AUTOLINKABLE = [
    'https://evil.example/x',
    'HTTP://evil.example/x',
    'FtP://evil.example/x',
    'www.evil.example',
    'foo.@evil.example',
  ] as const;

  test.each(AUTOLINKABLE)('no field turns %s into a link', (url) => {
    const out = withArtifacts(
      minimalBrief(`positioning: { category: ${JSON.stringify(`a ${url} b`)} }`),
      ledgerWith(claim('C-001', `s ${url}`, `observed ${url}`, `high ${url}`, [
        src('site:/a', `q ${url}`, 'supports'),
      ])),
    );
    // Defused either by a backslash (markdown contexts) or by an entity
    // (raw-HTML islands, where a backslash would display literally).
    for (const m of out.matchAll(/(https?|ftp):\/\//gi)) {
      expect(out.slice(Math.max(0, m.index - 1), m.index), `bare ${m[0]}`).toBe('\\');
    }
    expect(out).not.toMatch(/(?<![\\;])www\./i);
    expect(out).not.toMatch(/(?<![\\;])@evil/);
  });

  test('a quoted URL does not become a live link or grow a backslash', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'linky', 'observed', 'high', [
        src('site:/p', 'See [docs](https://evil.example) and www.evil.example', 'supports'),
      ])),
    );
    expect(out).toContain('https\\://evil.example');
    expect(out).toContain('www\\.evil.example');
  });

  // Every shape below defeated a hand-written fence scanner at some point:
  // counting markers, then parsing lines but missing containers, CRLF and
  // non-homogeneous runs. The section is last instead, so none of it can reach
  // the evidence — and nothing is appended to the author's file.
  test.each([
    ['unclosed, even count', ['```js', 'a', '```python', 'b']],
    ['balanced, odd count', ['```yaml', 'a', '```bash', 'b', '```']],
    ['tilde cannot close a backtick fence', ['```text', 'a', '~~~']],
    ['plain unclosed', ['```bash', 'echo oops']],
    ['balanced', ['```bash', 'echo ok', '```']],
    ['unclosed inside a list item', ['- step one', '', '  ```bash', '  run it']],
    ['unclosed inside a blockquote', ['> note', '> ```sh', '> run']],
    ['non-homogeneous run', ['~~~`js`', 'a', '~~~']],
    ['crlf line endings', ['```bash\r', 'echo ok\r', '```\r']],
  ])('the evidence survives findings.md: %s', (_name, lines) => {
    writeFileSync(join(scratch, 'findings.md'), ['# Findings', '', ...lines].join('\n'));
    const out = withArtifacts(journalBrief());
    // The evidence heading and its claims precede the findings section, so no
    // block the author opened can reach them.
    expect(out).toContain('## The evidence, claim by claim');
    expect(out.indexOf('## The evidence, claim by claim'))
      .toBeLessThan(out.indexOf('## What the analyze pass flagged'));
    expect(out).toContain('<span id="c-001"></span>');
    // Nothing is appended to what the author wrote.
    const section = findingsSection(out);
    const before = lines.filter((l) => /^ {0,3}[`~]{3,}/.test(l.replace(/\r/g, ''))).length;
    const after = (section.match(/^ {0,3}[`~]{3,}/gm) ?? []).length;
    expect(after, 'fence markers added').toBe(before);
  });

  test('a CRLF findings file does not render a duplicate heading', () => {
    writeFileSync(join(scratch, 'findings.md'), '# Findings\r\n\r\n## Gaps\r\n\r\nnone\r\n');
    const section = findingsSection(withArtifacts(journalBrief()));
    expect(section).not.toContain('# Findings');
    expect(section).toContain('### Gaps');
  });

  test('a statement ending in a period does not double it', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(
        [...claim('C-001', 'The README states five projects.', 'observed', 'high'), '    contradicts: [C-002]'],
        claim('C-002', 'The site states three projects.', 'observed', 'high'),
      ),
    );
    expect(out).not.toContain('..');
    expect(out).toContain('projects.** Both sources are recorded');
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

  // The pair used to round-trip through a '|'-joined dedupe key, so an id
  // carrying one recovered no claim and the row rendered from undefined.
  test('a claim id containing the old dedupe delimiter still renders its row', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(
        [...claim('A|B', 'first side', 'observed', 'high'), '    contradicts: ["C|D"]'],
        claim('C|D', 'second side', 'observed', 'high'),
      ),
    );
    expect(out).toContain('## Unresolved contradictions');
    expect(out).toContain('says **first side**');
    expect(out).toContain('says **second side**');
    expect(out).not.toContain('****');
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

  // Everything the analyze pass wrote lands between its heading and the next
  // section; only that span carries untrusted content.
  function findingsSection(out: string): string {
    const start = out.indexOf('## What the analyze pass flagged');
    expect(start).toBeGreaterThan(-1);
    const rest = out.slice(start + 1);
    const end = rest.indexOf('\n## ');
    return end === -1 ? rest : rest.slice(0, end);
  }

  // A character is inert only when an ODD number of backslashes precedes it:
  // an even run is a literal backslash followed by live syntax.
  function expectEscaped(section: string, chars: string) {
    for (const m of section.matchAll(new RegExp(`(\\\\*)([${chars}])`, 'g'))) {
      expect(m[1].length % 2, `${m[2]} after ${m[1].length} backslashes`).toBe(1);
    }
  }

  test('raw HTML in findings.md cannot form a tag, fenced or not', () => {
    // Fences are not a trust boundary: content is escaped either way, so a
    // fence the parser disagrees about cannot hand anything through live.
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
        '<img src=x onerror=alert(1)>',
        '```',
      ].join('\n'),
    );
    const section = findingsSection(withArtifacts(journalBrief()));
    expectEscaped(section, '<');
    expect(section).toContain('### Contradictions');
  });

  // Judging destinations means re-deciding, per line and before entity
  // decoding, what the parser decides later and across lines. Neutralising the
  // syntax removes the question: these forms all bypassed a destination filter.
  test('no link syntax in findings.md can form an anchor', () => {
    writeFileSync(
      join(scratch, 'findings.md'),
      [
        '# Findings',
        '',
        'Plain [click](javascript:alert(1)).',
        'Entity [c1](&#106;avascript:alert(1)).',
        'Tab [c2](java&Tab;script:alert(1)).',
        'Split ref [c3]:',
        'javascript:alert(1)',
        'Split paren [c4](',
        'javascript:alert(1))',
        // A backslash already in the input pairs with an injected one, handing
        // the brackets back to the parser as live syntax.
        'Pre-escaped \\[c5\\](javascript:alert(1)).',
        'Bare https://evil.example and www.evil.example and a@evil.example.',
        'Raw <img src=x onerror=alert(1)> and <javascript:alert(1)>.',
      ].join('\n'),
    );
    const section = findingsSection(withArtifacts(journalBrief()));
    expectEscaped(section, '[\\]()<');
    expect(section).toContain('https\\://evil.example');
    expect(section).toContain('www\\.evil.example');
    expect(section).toContain('a\\@evil.example');
  });

  // Both controls below are security-load-bearing and were unasserted:
  // removing either left the whole suite green.
  test('a newline in a table cell cannot start a new block', () => {
    const out = withArtifacts(
      minimalBrief([
        'site_inventory:',
        '  - locator: site:/a',
        '    page_type: docs',
        '    rationale: "keep\\n\\nsecond block"',
      ].join('\n')),
    );
    expect(out).toContain('keep second block');
    expect(out).not.toMatch(/\|[^|\n]*\n\nsecond/);
  });

  test('an inherited key is not mistaken for a stance label', () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'inherited', 'observed', 'high', [
        src('site:/a', 'q', 'constructor'),
      ])),
    );
    expect(out).not.toContain('native code');
    expect(out).toContain('constructor');
  });

  test('fence confusion cannot hand content through unescaped', () => {
    // CommonMark forbids a backtick in a backtick fence's info string, so the
    // parser opens no fence here even though the line looks like one.
    writeFileSync(
      join(scratch, 'findings.md'),
      ['# Findings', '', '```js`weird', '<img src=x onerror=alert(1)>', '```'].join('\n'),
    );
    expectEscaped(findingsSection(withArtifacts(journalBrief())), '<');
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

  test('a lone CR cannot break out of a blockquote or a table row', () => {
    const ledger = ledgerWith(
      claim('C-001', 'S.', 'observed', 'high', [
        src('site:/a', 'The vendor says X.\r\rNot the analyst speaking.', 'supports'),
      ]),
    );
    const brief = minimalBrief([
      'workflows:',
      '  - name: w',
      '    steps:',
      `      - { step: s1, description: ${JSON.stringify('first half\r\rsecond half')} }`,
    ].join('\n'));
    const out = withArtifacts(brief, ledger);
    expect(out).not.toContain('\r');
    for (const line of out.split('\n')) {
      if (line.includes('Not the analyst speaking')) expect(line, line).toStartWith('> ');
    }
    expect(out).toContain('first half second half');
  });

  test('a trailing backslash cannot swallow an island closing tag', () => {
    const ledger = ledgerWith(claim('C-001', 'S.', 'observed', JSON.stringify('high\\')));
    const brief = minimalBrief('positioning: { category: journal, claims: ["C-001\\\\"] }');
    const out = withArtifacts(brief, ledger);
    expect(out).toContain('high&#92;</span>');
    expect(out).toContain('c-001&#92;');
    expect(out).not.toMatch(/\\<\/(?:span|a)>/);
  });

  test('one claim reads "1 claim", an empty mix has no dangling dash', () => {
    const one = withArtifacts(minimalBrief(''), ledgerWith(claim('C-001', 'S.', 'observed', 'high')));
    expect(one).toContain('1 claim — 1 observed');
    expect(one).not.toContain('1 claims');
    const empty = withArtifacts(minimalBrief(''), ledgerWith());
    expect(empty).toContain('0 claims</span>');
    expect(empty).not.toContain('0 claims —');
  });

  test('ledger provenance and origin detail reach the page', () => {
    const brief = [
      "brief_version: '1.0'",
      'subject:',
      '  name: acme',
      '  origins:',
      '    - { id: kit, kind: repo, target: repo:../kit }',
      '    - { id: docs, kind: site, target: gh:acme/docs }',
      'evidence: { ledger: ledger.yaml }',
    ].join('\n');
    const out = withArtifacts(brief, ledgerWith(claim('C-001', 'S.', 'observed', 'high')));
    expect(out).toContain('Generated</strong> 2026-07-28');
    expect(out).toContain('Ledger generated by <code>t</code> at 2026-07-28.');
    expect(out).toContain('Origins: **kit** (repo) <code>repo:../kit</code> · **docs** (site) <code>gh:acme/docs</code>.');
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

  test('--out with no path is an error; with a path it writes there', () => {
    const script = join(skillRoot, 'scripts', 'render.ts');
    for (const f of ['brief.yaml', 'ledger.yaml']) {
      copyFileSync(join(mixed, f), join(scratch, f));
    }
    const bad = spawnSync('bun', [script, scratch, '--out'], { encoding: 'utf-8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('usage:');
    const target = join(scratch, 'custom.md');
    const good = spawnSync('bun', [script, scratch, '--out', target], { encoding: 'utf-8' });
    expect(good.status, good.stderr).toBe(0);
    expect(readFileSync(target, 'utf-8')).toContain('what the evidence says');
  });
});
