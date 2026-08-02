import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// The docs shipped with red warning boxes advertising the kit's own gaps.
// docs/site/EDITORIAL.md is the standard; this test is its teeth: danger is
// never used, and every caution is a deliberate, allowlisted, user-protective
// warning rather than self-description of a weakness.
const repoRoot = dirname(dirname(import.meta.dir));
const contentRoot = join(repoRoot, 'docs', 'site', 'src', 'content', 'docs');

const ALLOWED_CAUTIONS: Record<string, string[]> = {
  'getting-started/requirements.md': ['Install `jq` before running the installer'],
  'getting-started/upgrading.md': ['Local edits inside an installed skill are destroyed on upgrade'],
  'cookbook/contain-a-build.md': ['Provision `agent-work.slice` on the host first'],
  'cookbook/gate-a-merge.md': ['Keep the record out of git'],
  'reference/cli-and-tools.md': ['Pass an explicit file list'],
};

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

  test('no page uses a danger callout', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      expect(text, relative(contentRoot, file)).not.toMatch(/:::danger|<Aside[^>]*type="danger"/);
    }
  });

  test('every caution is allowlisted by file and title', () => {
    for (const file of files) {
      const page = relative(contentRoot, file);
      const text = readFileSync(file, 'utf-8');
      const cautions = [...text.matchAll(/:::caution(?:\[([^\]]*)\])?/g)].map(
        (match) => match[1] ?? '',
      );
      const allowed = ALLOWED_CAUTIONS[page] ?? [];
      for (const title of cautions) {
        expect(allowed, `${page}: :::caution[${title}]`).toContain(title);
      }
      expect(text, page).not.toMatch(/<Aside[^>]*type="caution"/);
    }
  });

  test('the allowlist carries no stale entries', () => {
    for (const [page, titles] of Object.entries(ALLOWED_CAUTIONS)) {
      const text = readFileSync(join(contentRoot, page), 'utf-8');
      for (const title of titles) {
        expect(text, `${page} no longer carries "${title}"`).toContain(`:::caution[${title}]`);
      }
    }
  });
});
