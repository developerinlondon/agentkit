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

  test('verbatim ledger quotes appear in the evidence section', () => {
    const out = page();
    expect(out).toContain('"Free — up to 3 projects"');
    expect(out).toContain('`site:/pricing#plans`, as of 2026-07-27');
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
