import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// The docs shipped with red warning boxes advertising the kit's own gaps.
// docs/hextra/EDITORIAL.md is the standard; this test is its teeth: danger is
// never used, and every caution is a deliberate, allowlisted, user-protective
// warning rather than self-description of a weakness.
const repoRoot = dirname(dirname(import.meta.dir));
const contentRoot = join(repoRoot, 'docs', 'hextra', 'content');

function contentFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...contentFiles(path));
    else if (/\.mdx?$/.test(entry)) files.push(path);
  }
  return files;
}

describe('docs follow the editorial callout policy', () => {
  const files = contentFiles(contentRoot);

  test('the content tree is where we think it is', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  // Hextra's callout vocabulary is info / warning / error. `error` is the
  // escalation Starlight spelled `danger`, and the standard is the same: it is
  // never used. `warning` is this theme's ordinary emphasis callout rather than
  // the rare deliberate escalation `caution` was, so it is not allowlisted.
  test('no page uses an error callout', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      expect(text, relative(contentRoot, file)).not.toMatch(/\{\{<\s*callout\s+type="error"/);
    }
  });
});
