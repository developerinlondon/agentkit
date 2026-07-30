// Walks a real docs build and asserts the Pages worker would accept every file.
// This is a build-time check rather than a test: it needs `docs/site/dist`, and a
// test that depends on another CI job having built something is fragile — that
// exact coupling broke the suite once already. The hermetic half of this check,
// which is the half that catches a missing extension, lives in
// tests/docs/asset-types.test.ts and needs no build.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import worker from '../pages/worker/src/worker.js';

const DIST = join(import.meta.dir, '..', 'docs', 'site', 'dist');
const SITE_TOKEN = 'site-secret';

if (!existsSync(DIST)) {
  console.error(`check-dist-assets: ${DIST} is missing — build the docs site first`);
  process.exit(1);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const store = new Map<string, unknown>();
const env = {
  SITE_TOKEN,
  PUBLISH_TOKEN: 'publish-secret',
  PAGES: {
    async get(key: string) {
      return store.has(key) ? { body: store.get(key) } : null;
    },
    async head(key: string) {
      return store.has(key) ? {} : null;
    },
    async put(key: string, body: unknown) {
      store.set(key, body);
    },
    async delete(key: string) {
      store.delete(key);
    },
  },
};

const rejected: string[] = [];
const files = walk(DIST);

for (const file of files) {
  const rel = relative(DIST, file).replaceAll('\\', '/');
  const res = await worker.fetch(
    new Request(`https://agentkit.sbs/api/site/docs/${rel}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${SITE_TOKEN}` },
      body: 'x',
    }),
    env,
  );
  if (res.status !== 200) rejected.push(`${rel} -> ${res.status}`);
}

if (rejected.length > 0) {
  console.error(`check-dist-assets: the worker would refuse ${rejected.length} built file(s):`);
  for (const line of rejected) console.error(`  ${line}`);
  console.error('add the extension to EXT_TYPES in pages/worker/src/worker.js');
  process.exit(1);
}

const extensions = new Set(files.map((f) => f.replace(/^.*\./, '')));
console.log(
  `check-dist-assets: ${files.length} file(s) publishable, `
    + `${extensions.size} extension(s): ${[...extensions].sort().join(' ')}`,
);
