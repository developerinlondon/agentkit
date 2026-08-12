// Fails on a dangling internal link, which Hugo does not check itself.
//
// It walks the BUILT output rather than the markdown: a rewritten link, a
// shortcode-generated href and a hand-written one all land in the same place,
// and only the built tree knows which pages exist.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const publicDir = resolve(import.meta.dir, '..', 'public');
const BASE = '/docs';

// Hugo writes every page as <path>/index.html, plus real files for assets.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(publicDir);
const pages = files.filter((file) => file.endsWith('.html'));

// Everything addressable: a built file by its own path, and a page by the
// directory URL Hugo serves it at.
const addressable = new Set<string>();
for (const file of files) {
  const rel = `/${relative(publicDir, file).split('\\').join('/')}`;
  addressable.add(rel);
  if (rel.endsWith('/index.html')) {
    addressable.add(rel.slice(0, -'index.html'.length));
  }
}

const HREF = /(?:href|src)="([^"]+)"/g;
const broken: { page: string; href: string }[] = [];

for (const page of pages) {
  const html = readFileSync(page, 'utf-8');
  for (const [, raw] of html.matchAll(HREF)) {
    if (!raw.startsWith('/')) continue; // external, anchor, or relative to the page
    const path = (raw.split('#')[0] ?? '').split('?')[0] ?? '';
    if (path === '') continue;
    // baseURL puts the site under /docs; the built tree is rooted above it.
    const target = path.startsWith(`${BASE}/`) ? path.slice(BASE.length) : path;
    const candidates = [target, target.endsWith('/') ? `${target}index.html` : `${target}/`];
    if (candidates.some((candidate) => addressable.has(candidate))) continue;
    broken.push({ page: `/${relative(publicDir, page)}`, href: raw });
  }
}

if (broken.length > 0) {
  console.error(`check-links: ${broken.length} dangling internal link(s)\n`);
  for (const { page, href } of broken) console.error(`  ${page}\n    → ${href}`);
  process.exit(1);
}

console.log(`check-links: ${pages.length} pages, every internal link resolves`);
