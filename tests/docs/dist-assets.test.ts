import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import worker from '../../pages/worker/src/worker.js';

const DIST = join(import.meta.dir, '..', '..', 'docs', 'site', 'dist');
const SITE_TOKEN = 'site-secret';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function bucket() {
  const writes = new Map<string, unknown>();
  return {
    writes,
    async get(key: string) {
      return writes.has(key) ? { body: writes.get(key) } : null;
    },
    async head(key: string) {
      return writes.has(key) ? {} : null;
    },
    async put(key: string, body: unknown) {
      writes.set(key, body);
    },
    async delete(key: string) {
      writes.delete(key);
    },
  };
}

// Guards the whole class that F1 belonged to. The deploy could never have
// succeeded because Pagefind emits a `pf_filter` and nobody had listed that
// extension — a hand-maintained fixture cannot catch the extension nobody
// thought of, but a walk over a real build can.
describe('every file a real build emits is publishable', () => {
  test('the build output exists', () => {
    expect(
      existsSync(DIST),
      `${DIST} is missing — run the docs build before this slice:\n` +
        '  cd docs/site && node ./node_modules/astro/bin/astro.mjs build',
    ).toBe(true);
  });

  test('the worker accepts every built path on the write route', async () => {
    const store = bucket();
    const rejected: string[] = [];

    for (const file of walk(DIST)) {
      const rel = relative(DIST, file).replaceAll('\\', '/');
      const res = await worker.fetch(
        new Request(`https://agentkit.sbs/api/site/docs/${rel}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${SITE_TOKEN}` },
          body: 'x',
        }),
        { PAGES: store, SITE_TOKEN, PUBLISH_TOKEN: 'publish-secret' },
      );
      if (res.status !== 200) rejected.push(`${rel} -> ${res.status}`);
    }

    expect(rejected).toEqual([]);
  });

  // The walk above only covers what today's build happens to emit, and Pagefind
  // writes a filter shard only when the index has filters — so the very extension
  // that broke the deploy is absent from dist right now. This list is the
  // deterministic half: it fails if any Pagefind artifact loses its mapping,
  // whether or not the current build produces one.
  test.each([
    'pagefind/pagefind.js',
    'pagefind/wasm.en.pagefind',
    'pagefind/pagefind.en_abc123.pf_meta',
    'pagefind/index/en_abc123.pf_index',
    'pagefind/fragment/en_abc123.pf_fragment',
    'pagefind/filter/en_abc123.pf_filter',
  ])('the write route accepts %s even when this build emits none', async (rel) => {
    const store = bucket();
    const res = await worker.fetch(
      new Request(`https://agentkit.sbs/api/site/docs/${rel}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${SITE_TOKEN}` },
        body: 'x',
      }),
      { PAGES: store, SITE_TOKEN, PUBLISH_TOKEN: 'publish-secret' },
    );

    expect(res.status).toBe(200);
  });

  test('every built extension has an explicit content type, never the fallback', async () => {
    const store = bucket();
    const fallback: string[] = [];

    for (const file of walk(DIST)) {
      const rel = relative(DIST, file).replaceAll('\\', '/');
      await worker.fetch(
        new Request(`https://agentkit.sbs/api/site/docs/${rel}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${SITE_TOKEN}` },
          body: 'x',
        }),
        { PAGES: store, SITE_TOKEN, PUBLISH_TOKEN: 'publish-secret' },
      );
      const res = await worker.fetch(new Request(`https://agentkit.sbs/docs/${rel}`), {
        PAGES: store,
        SITE_TOKEN,
        PUBLISH_TOKEN: 'publish-secret',
      });
      // Pagefind's shards are deliberately octet-stream; anything else landing
      // there means a new extension arrived unnoticed.
      if (
        res.headers.get('content-type') === 'application/octet-stream'
        && !/\.(pagefind|pf_[a-z]+)$/.test(rel)
      ) {
        fallback.push(rel);
      }
    }

    expect(fallback).toEqual([]);
  });
});
