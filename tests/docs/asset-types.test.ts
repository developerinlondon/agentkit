import { describe, expect, test } from 'bun:test';
import worker from '../../pages/worker/src/worker.js';

const SITE_TOKEN = 'site-secret';

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

async function put(rel: string) {
  const store = bucket();
  return worker.fetch(
    new Request(`https://agentkit.sbs/api/site/docs/${rel}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${SITE_TOKEN}` },
      body: 'x',
    }),
    { PAGES: store, SITE_TOKEN, PUBLISH_TOKEN: 'publish-secret' },
  );
}

// The deploy could never have succeeded because Pagefind emits a `pf_filter` and
// nobody had listed that extension. Pagefind only writes a filter shard when the
// index has filters, so the current build emits none — meaning a walk over the
// real output cannot catch this. This list can, and needs no build to do it.
describe('every artifact a Starlight build can emit is publishable', () => {
  test.each([
    'index.html',
    'getting-started/install/index.html',
    '_astro/app.aYS1OYVv.css',
    '_astro/page.LAbJoB63.js',
    'favicon.svg',
    'sitemap-0.xml',
    'sitemap-index.xml',
    'pagefind/pagefind.js',
    'pagefind/pagefind-entry.json',
    'pagefind/wasm.en.pagefind',
    'pagefind/pagefind.en_abc123.pf_meta',
    'pagefind/index/en_abc123.pf_index',
    'pagefind/fragment/en_abc123.pf_fragment',
    'pagefind/filter/en_abc123.pf_filter',
  ])('%s is accepted on the write route', async (rel) => {
    expect((await put(rel)).status).toBe(200);
  });

  test('an extension nobody mapped is refused rather than stored as a guess', async () => {
    expect((await put('_astro/app.unmapped')).status).toBe(400);
  });
});
