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
    for (const line of ['line one', '## Injected Heading', 'line three']) {
      expect(out, line).toContain(`> ${line}`);
    }
    expect(out).not.toMatch(/^## Injected Heading/m);
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
    expect(out).toContain('`execute`');
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
    expect(out).toContain('— supports, `site:/pricing#plans`, as of 2026-07-27');
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
