import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
const SITE_SRC = join(REPO, 'pages', 'site', 'src');
const DOCS = join(REPO, 'docs', 'site', 'src', 'content', 'docs');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(html|css|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function docsLinks(): { file: string; href: string }[] {
  const found: { file: string; href: string }[] = [];
  for (const file of sourceFiles(SITE_SRC)) {
    const body = readFileSync(file, 'utf-8');
    for (const match of body.matchAll(/href="(\/docs\/[^"]*)"/g)) {
      found.push({ file: relative(file), href: match[1] ?? '' });
    }
  }
  return found;
}

function relative(path: string): string {
  return path.slice(REPO.length + 1);
}

// `/docs/a/b/` is served either by content/docs/a/b.{md,mdx} or by
// content/docs/a/b/index.{md,mdx} — a section landing page uses the latter, and
// checking only the first shape reports live pages as broken.
function pageExists(href: string): boolean {
  const slug = href.replace(/^\/docs\/?/, '').replace(/\/$/, '');
  const base = slug === '' ? 'index' : slug;
  return ['md', 'mdx'].some((ext) =>
    existsSync(join(DOCS, `${base}.${ext}`)) || existsSync(join(DOCS, base, `index.${ext}`))
  );
}

// The marketing page and the docs used to live in separate repositories, so
// nothing could check a link from one into the other. Nineteen of them 404'd at
// once when the docs moved: the old pages were deleted, their redirects removed,
// and this page was never audited. In one repository it is a static check.
describe('every marketing link into the docs resolves', () => {
  test('the page links into the docs at all', () => {
    expect(docsLinks().length).toBeGreaterThan(0);
  });

  test('each /docs/ href names a page that exists', () => {
    const broken = docsLinks()
      .filter((link) => !pageExists(link.href))
      .map((link) => `${link.file}: ${link.href}`);

    expect(broken).toEqual([]);
  });
});
