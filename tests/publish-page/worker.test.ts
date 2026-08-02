import { describe, expect, test } from 'bun:test';
import worker from '../../pages/worker/src/worker.js';

const SITE_TOKEN = 'site-secret';
const PUBLISH_TOKEN = 'publish-secret';
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

interface Bucket {
  reads: string[];
  writes: Map<string, { body: string; contentType: string }>;
  get(key: string): Promise<{ body: string } | null>;
  put(key: string, body: ArrayBuffer, options: { httpMetadata: { contentType: string } }): Promise<void>;
  head(key: string): Promise<Record<string, never> | null>;
  delete(key: string): Promise<void>;
}

function bucket(seed: Record<string, string> = {}): Bucket {
  const writes = new Map(
    Object.entries(seed).map(([key, body]) => [key, { body, contentType: 'seed' }]),
  );
  return {
    reads: [],
    writes,
    async get(key) {
      this.reads.push(key);
      const stored = writes.get(key);
      return stored ? { body: stored.body } : null;
    },
    async put(key, body, options) {
      writes.set(key, {
        body: new TextDecoder().decode(body),
        contentType: options.httpMetadata.contentType,
      });
    },
    async head(key) {
      return writes.has(key) ? {} : null;
    },
    async delete(key) {
      writes.delete(key);
    },
    async list({ prefix }: { prefix: string }) {
      const objects = [...writes.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key }));
      return { objects, truncated: false };
    },
  };
}

function env(PAGES: Bucket, overrides: Record<string, string | undefined> = {}) {
  return { PAGES, SITE_TOKEN, PUBLISH_TOKEN, ...overrides };
}

const SEEDED: Record<string, string> = {
  '_site/docs/index.html': '<h1>seeded site</h1>',
  'pages/deadbeef/index.html': '<h1>seeded page</h1>',
};

function get(url: string) {
  return new Request(url);
}

function write(url: string, token: string | null, body = '<!doctype html>hi', headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'PUT',
    body,
    headers: token === null ? headers : { authorization: `Bearer ${token}`, ...headers },
  });
}

function legacyApiUrl(slug: string) {
  const target = new URL(`https://pages.agentkit.sbs/api/pages/${slug}`);
  const normalized = target.pathname.slice('/api/pages/'.length).replace(/\/$/, '');
  if (normalized === '_site' || normalized === '_pages-index' || normalized.startsWith('_site/')) {
    target.hostname = 'agentkit.sbs';
  }
  return target.toString();
}

describe('apex site routing', () => {
  test('root serves the site index, indexable', async () => {
    const store = bucket({ '_site/index.html': '<h1>home</h1>' });
    const res = await worker.fetch(get('https://agentkit.sbs/'), env(store));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>home</h1>');
    expect(res.headers.get('x-robots-tag')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  test('www root serves the same key', async () => {
    const store = bucket({ '_site/index.html': '<h1>home</h1>' });
    const res = await worker.fetch(get('https://www.agentkit.sbs/'), env(store));

    expect(res.status).toBe(200);
    expect(store.reads).toEqual(['_site/index.html']);
  });

  test.each([
    ['https://agentkit.sbs/docs', '_site/docs/index.html'],
    ['https://agentkit.sbs/docs/install', '_site/docs/install/index.html'],
    ['https://agentkit.sbs/docs/install/', '_site/docs/install/index.html'],
    ['https://www.agentkit.sbs/guides/a-b-c', '_site/guides/a-b-c/index.html'],
  ])('%s serves %s with no noindex', async (url, key) => {
    const store = bucket({ [key]: '<h1>page</h1>' });
    const res = await worker.fetch(get(url), env(store));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>page</h1>');
    expect(res.headers.get('x-robots-tag')).toBeNull();
    expect(store.reads).toEqual([key]);
  });

  test('absent sub-path 404s with the site 404 page', async () => {
    const store = bucket({ '_site/index.html': '<h1>home</h1>' });
    const res = await worker.fetch(get('https://agentkit.sbs/docs/missing'), env(store));

    expect(res.status).toBe(404);
    expect(await res.text()).toContain('No page lives at this address');
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  test.each([
    'https://agentkit.sbs/Docs',
    'https://agentkit.sbs/-docs',
    'https://agentkit.sbs/docs//install',
    'https://agentkit.sbs/a/b/c/d/e',
    'https://agentkit.sbs/index.html',
    'https://agentkit.sbs/pages-index.html',
    'https://agentkit.sbs/docs%2Finstall',
  ])('%s never reaches R2', async (url) => {
    const store = bucket();
    const res = await worker.fetch(get(url), env(store));

    expect(res.status).toBe(404);
    expect(store.reads).toEqual([]);
  });

  // The URL parser decodes and collapses dot segments before the worker sees a
  // path, so traversal cannot survive to the key — it resolves within the site.
  test.each([
    ['https://agentkit.sbs/docs/%2e%2e/secret', '_site/secret/index.html'],
    ['https://agentkit.sbs/docs/../secret', '_site/secret/index.html'],
    ['https://agentkit.sbs/../../pages/evil', '_site/pages/evil/index.html'],
  ])('%s stays inside the site keyspace', async (url, key) => {
    const store = bucket();
    await worker.fetch(get(url), env(store));

    expect(store.reads).toEqual([key]);
  });
});

describe('published pages stay noindex', () => {
  test('a page slug serves with noindex', async () => {
    const store = bucket({ 'pages/deadbeef/index.html': '<h1>artifact</h1>' });
    const res = await worker.fetch(get('https://pages.agentkit.sbs/deadbeef'), env(store));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>artifact</h1>');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  test('the pages index serves with noindex', async () => {
    const store = bucket({ '_site/pages-index.html': '<h1>index</h1>' });
    const res = await worker.fetch(get('https://pages.agentkit.sbs/'), env(store));

    expect(res.status).toBe(200);
    expect(store.reads).toEqual(['_site/pages-index.html']);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('site writes', () => {
  test.each([
    ['_site', '_site/index.html', 'https://agentkit.sbs/'],
    ['_pages-index', '_site/pages-index.html', 'https://pages.agentkit.sbs/'],
    ['_site/docs', '_site/docs/index.html', 'https://agentkit.sbs/docs'],
    ['_site/docs/install', '_site/docs/install/index.html', 'https://agentkit.sbs/docs/install'],
  ])('SITE_TOKEN writes %s to %s', async (slug, key, url) => {
    const store = bucket();
    const res = await worker.fetch(
      write(`https://agentkit.sbs/api/pages/${slug}`, SITE_TOKEN, '<h1>new</h1>'),
      env(store),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug, url });
    expect(store.writes.get(key)?.body).toBe('<h1>new</h1>');
    expect(store.writes.get(key)?.contentType).toBe('text/html; charset=utf-8');
  });

  test('a site write is served back from the apex host', async () => {
    const store = bucket();
    await worker.fetch(
      write('https://agentkit.sbs/api/pages/_site/docs/install', SITE_TOKEN, '<h1>install</h1>'),
      env(store),
    );
    const res = await worker.fetch(get('https://agentkit.sbs/docs/install'), env(store));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>install</h1>');
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  test('SITE_TOKEN deletes a site sub-path', async () => {
    const store = bucket({ '_site/docs/index.html': '<h1>docs</h1>' });
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/pages/_site/docs', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${SITE_TOKEN}` },
      }),
      env(store),
    );

    expect(res.status).toBe(200);
    expect(store.writes.has('_site/docs/index.html')).toBe(false);
  });

  test.each([
    '_site/Docs',
    '_site/-docs',
    '_site/_site',
    '_site/docs//install',
    '_site/docs%2Finstall',
    '_site/a/b/c/d/e',
    `_site/${'a'.repeat(65)}`,
    '_site/docs/index.html',
  ])('rejects the malformed site path %s', async (slug) => {
    const store = bucket();
    const res = await worker.fetch(
      write(`https://agentkit.sbs/api/pages/${slug}`, SITE_TOKEN),
      env(store),
    );

    expect(res.status).toBe(400);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test('a trailing slash still addresses the site index', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/pages/_site/', SITE_TOKEN, '<h1>home</h1>'),
      env(store),
    );

    expect(res.status).toBe(200);
    expect(store.writes.get('_site/index.html')?.body).toBe('<h1>home</h1>');
  });
});

async function expectWriteRejected(slug: string, token: string | null, overrides = {}) {
  const store = bucket();
  const res = await worker.fetch(
    write(legacyApiUrl(slug), token, '<h1>defaced</h1>'),
    env(store, overrides),
  );

  expect(res.status).toBe(401);
  expect([...store.writes.keys()]).toEqual([]);
}

describe('token separation', () => {
  test.each(['_site', '_pages-index', '_site/docs', '_site/docs/install'])(
    'PUBLISH_TOKEN cannot write %s',
    (slug) => expectWriteRejected(slug, PUBLISH_TOKEN),
  );

  test('PUBLISH_TOKEN cannot delete site content', async () => {
    const store = bucket({ '_site/docs/index.html': '<h1>docs</h1>' });
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/pages/_site/docs', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      }),
      env(store),
    );

    expect(res.status).toBe(401);
    expect(store.writes.has('_site/docs/index.html')).toBe(true);
  });

  test.each(['deadbeef', 'design/agentkit-pages', 'pages/evil'])(
    'SITE_TOKEN cannot write the page slug %s',
    (slug) => expectWriteRejected(slug, SITE_TOKEN),
  );

  // The URL parser collapses the traversal before the worker sees it, leaving a
  // plain page slug — which SITE_TOKEN must still not be able to write.
  test.each(['_site/../evil', '_site/%2e%2e/evil', '_site/../pages/evil'])(
    'the traversal write %s normalises to a page slug SITE_TOKEN cannot reach',
    (slug) => expectWriteRejected(slug, SITE_TOKEN),
  );

  test('PUBLISH_TOKEN still writes a page slug', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write(legacyApiUrl('deadbeef'), PUBLISH_TOKEN, '<h1>page</h1>'),
      env(store),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      slug: 'deadbeef',
      url: 'https://pages.agentkit.sbs/deadbeef',
    });
    expect(store.writes.get('pages/deadbeef/index.html')?.body).toBe('<h1>page</h1>');
  });

  test('an unauthenticated site write is rejected', () =>
    expectWriteRejected('_site/docs', null));

  // `constructor` is the only Object.prototype member SLUG_RE admits, so it is
  // the one slug that can tell an own-property reserved-slug lookup apart from
  // a prototype-walking one.
  test('a page slug named after an Object.prototype member is publishable', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write(legacyApiUrl('constructor'), PUBLISH_TOKEN, '<h1>ctor</h1>'),
      env(store),
    );

    expect(res.status).toBe(200);
    expect([...store.writes.keys()]).toEqual(['pages/constructor/index.html']);
    expect(store.writes.get('pages/constructor/index.html')?.body).toBe('<h1>ctor</h1>');
  });

  test('SITE_TOKEN cannot write the Object.prototype slug either', () =>
    expectWriteRejected('constructor', SITE_TOKEN));

  // Site-space membership is anchored at position 0. A slug that merely
  // contains the prefix is a page slug; treating it as site-space would slice
  // it at the wrong offset and land the write on an unrelated key.
  test.each(['a/_site/b', 'docs/_site/install'])(
    'the slug %s only contains the site prefix, so it is not site-space',
    (slug) => expectWriteRejected(slug, SITE_TOKEN),
  );
});

// An unset secret is already rejected by the equality check, because no token
// equals undefined. An empty secret is the state that check cannot judge —
// `'' !== ''` is false — so the emptiness guard is the only thing standing
// between an empty binding and anonymous writes to either keyspace.
const ABSENT_SECRET = [['unset', undefined], ['empty', '']] as const;
const WRITE_TARGETS = [
  ['_site/docs', '_site/docs/index.html', 'SITE_TOKEN'],
  ['deadbeef', 'pages/deadbeef/index.html', 'PUBLISH_TOKEN'],
] as const;
const ANONYMOUS_CASES = WRITE_TARGETS.flatMap(([slug, key, secret]) =>
  ABSENT_SECRET.flatMap(([state, value]) =>
    (['PUT', 'DELETE'] as const).map(
      (method) =>
        [`${method} ${slug} with ${secret} ${state}`, method, slug, key, secret, value] as const,
    ),
  ),
);

describe('writes fail closed when the secret is missing', () => {
  test.each(ANONYMOUS_CASES)(
    'an anonymous %s is refused and leaves the object untouched',
    async (_label, method, slug, key, secret, value) => {
      const store = bucket(SEEDED);
      const res = await worker.fetch(
        new Request(legacyApiUrl(slug), {
          method,
          ...(method === 'PUT' ? { body: '<h1>anonymous</h1>' } : {}),
        }),
        env(store, { [secret]: value }),
      );

      expect(res.status).toBe(401);
      expect(store.writes.get(key)?.body).toBe(SEEDED[key]);
    },
  );
});

describe('method allowlist', () => {
  test.each([
    ['POST', 'https://agentkit.sbs/'],
    ['POST', 'https://agentkit.sbs/docs'],
    ['PATCH', 'https://agentkit.sbs/docs'],
    ['OPTIONS', 'https://agentkit.sbs/docs'],
    ['PATCH', 'https://agentkit.sbs/api/pages/_site/docs'],
    ['POST', 'https://agentkit.sbs/api/pages/deadbeef'],
  ])('%s %s is refused without touching R2', async (method, url) => {
    const store = bucket(SEEDED);
    const res = await worker.fetch(new Request(url, { method }), env(store));

    expect(res.status).toBe(405);
    expect(store.reads).toEqual([]);
    expect([...store.writes.keys()].sort()).toEqual(Object.keys(SEEDED).sort());
  });

  test('the content origin hides every non-read route', async () => {
    const store = bucket(SEEDED);
    const res = await worker.fetch(
      new Request('https://pages.agentkit.sbs/deadbeef', { method: 'POST' }),
      env(store),
    );

    expect(res.status).toBe(404);
    expect(store.reads).toEqual([]);
  });
});

describe('size limits', () => {
  test('a declared oversize site write is rejected before the body is read', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/pages/_site/docs', SITE_TOKEN, 'small', {
        'content-length': String(MAX_PAGE_BYTES + 1),
      }),
      env(store),
    );

    expect(res.status).toBe(413);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test('an oversize site body is rejected', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/pages/_site/docs', SITE_TOKEN, 'a'.repeat(MAX_PAGE_BYTES + 1)),
      env(store),
    );

    expect(res.status).toBe(413);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test('an empty site body is rejected', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/pages/_site/docs', SITE_TOKEN, ''),
      env(store),
    );

    expect(res.status).toBe(413);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test('a body at the cap is accepted', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/pages/_site/docs', SITE_TOKEN, 'a'.repeat(MAX_PAGE_BYTES)),
      env(store),
    );

    expect(res.status).toBe(200);
    expect(store.writes.get('_site/docs/index.html')?.body.length).toBe(MAX_PAGE_BYTES);
  });
});

describe('the docs subtree serves a generated site', () => {
  test.each([
    ['https://agentkit.sbs/docs/', '_site/docs/index.html'],
    ['https://agentkit.sbs/docs/getting-started/install/', '_site/docs/getting-started/install/index.html'],
    ['https://agentkit.sbs/docs/0.4/getting-started/install/', '_site/docs/0.4/getting-started/install/index.html'],
    ['https://agentkit.sbs/docs/0.4/reference/hooks/pkg-police/checks/', '_site/docs/0.4/reference/hooks/pkg-police/checks/index.html'],
  ])('%s resolves as a page', async (url, key) => {
    const store = bucket({ [key]: '<h1>docs</h1>' });
    const res = await worker.fetch(get(url), env(store));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>docs</h1>');
    expect(store.reads).toEqual([key]);
  });

  test.each([
    ['_astro/common.aYS1OYVv.css', 'text/css; charset=utf-8'],
    ['_astro/page.LAbJoB63.js', 'text/javascript; charset=utf-8'],
    ['pagefind/index/en_c83d5de.pf_index', 'application/octet-stream'],
    ['pagefind/wasm.en.pagefind', 'application/octet-stream'],
    ['favicon.svg', 'image/svg+xml'],
    ['sitemap-0.xml', 'application/xml; charset=utf-8'],
  ])('docs/%s is served verbatim as %s', async (path, type) => {
    const key = `_site/docs/${path}`;
    const store = bucket({ [key]: 'asset-body' });
    const res = await worker.fetch(get(`https://agentkit.sbs/docs/${path}`), env(store));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset-body');
    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(store.reads).toEqual([key]);
  });

  test('an unknown extension resolves as a page, not a file', async () => {
    const store = bucket();
    await worker.fetch(get('https://agentkit.sbs/docs/0.4'), env(store));

    expect(store.reads).toEqual(['_site/docs/0.4/index.html']);
  });

  test('a missing asset 404s without the site 404 page', async () => {
    const store = bucket();
    const res = await worker.fetch(get('https://agentkit.sbs/docs/_astro/gone.css'), env(store));

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('No page lives at this address');
  });

  test('a docs page carries the relaxed policy and stays indexable', async () => {
    const store = bucket({ '_site/docs/index.html': '<h1>docs</h1>' });
    const res = await worker.fetch(get('https://agentkit.sbs/docs/'), env(store));
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  test('the marketing home keeps the strict policy', async () => {
    const store = bucket({ '_site/index.html': '<h1>home</h1>' });
    const res = await worker.fetch(get('https://agentkit.sbs/'), env(store));
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain('wasm-unsafe-eval');
  });

  test.each([
    'https://agentkit.sbs/index.html',
    'https://agentkit.sbs/pages-index.html',
    'https://agentkit.sbs/_astro/app.css',
    'https://agentkit.sbs/assets/app.css',
    'https://agentkit.sbs/docsy/app.css',
  ])('%s is not an asset path', async (url) => {
    const store = bucket();
    const res = await worker.fetch(get(url), env(store));

    expect(res.status).toBe(404);
    expect(store.reads).toEqual([]);
  });

  test('a published page host never serves docs assets', async () => {
    const store = bucket({ '_site/docs/_astro/app.css': 'css' });
    const res = await worker.fetch(get('https://pages.agentkit.sbs/docs/_astro/app.css'), env(store));

    expect(res.status).toBe(404);
    expect(store.writes.has('_site/docs/_astro/app.css')).toBe(true);
  });
});

describe('docs asset writes are SITE_TOKEN only', () => {
  test('a site token writes the key verbatim with a derived content type', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/site/docs/_astro/app.aYS1OYVv.css', SITE_TOKEN, 'body{}'),
      env(store),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      path: 'docs/_astro/app.aYS1OYVv.css',
      url: 'https://agentkit.sbs/docs/_astro/app.aYS1OYVv.css',
    });
    expect(store.writes.get('_site/docs/_astro/app.aYS1OYVv.css')).toEqual({
      body: 'body{}',
      contentType: 'text/css; charset=utf-8',
    });
  });

  test.each([
    ['the publish token', PUBLISH_TOKEN],
    ['no token', null],
  ])('%s cannot write a docs asset', async (_label, token) => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/site/docs/_astro/app.css', token, 'body{}'),
      env(store),
    );

    expect(res.status).toBe(401);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test('an unset site token fails closed', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/site/docs/_astro/app.css', '', 'body{}'),
      env(store, { SITE_TOKEN: undefined }),
    );

    expect(res.status).toBe(401);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test.each([
    'https://agentkit.sbs/api/site/index.html',
    'https://agentkit.sbs/api/site/assets/app.css',
    'https://agentkit.sbs/api/site/docs/app.unknownext',
    'https://agentkit.sbs/api/site/docs/.hidden/app.css',
    'https://agentkit.sbs/api/site/docs/getting-started',
  ])('%s is rejected as a path', async (url) => {
    const store = bucket();
    const res = await worker.fetch(write(url, SITE_TOKEN, 'body{}'), env(store));

    expect(res.status).toBe(400);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test('an empty asset body is rejected', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/site/docs/_astro/app.css', SITE_TOKEN, ''),
      env(store),
    );

    expect(res.status).toBe(413);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test('a declared length over the cap is rejected before the body is read', async () => {
    const store = bucket();
    const res = await worker.fetch(
      write('https://agentkit.sbs/api/site/docs/_astro/app.css', SITE_TOKEN, 'body{}', {
        'content-length': String(MAX_PAGE_BYTES + 1),
      }),
      env(store),
    );

    expect(res.status).toBe(413);
    expect([...store.writes.keys()]).toEqual([]);
  });

  test('a site token deletes a docs asset', async () => {
    const store = bucket({ '_site/docs/_astro/app.css': 'body{}' });
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/site/docs/_astro/app.css', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${SITE_TOKEN}` },
      }),
      env(store),
    );

    expect(res.status).toBe(200);
    expect(store.writes.has('_site/docs/_astro/app.css')).toBe(false);
  });

  test('deleting an absent docs asset 404s', async () => {
    const store = bucket();
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/site/docs/_astro/app.css', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${SITE_TOKEN}` },
      }),
      env(store),
    );

    expect(res.status).toBe(404);
  });

  test('the publish token cannot delete a docs asset', async () => {
    const store = bucket({ '_site/docs/_astro/app.css': 'body{}' });
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/site/docs/_astro/app.css', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      }),
      env(store),
    );

    expect(res.status).toBe(401);
    expect(store.writes.has('_site/docs/_astro/app.css')).toBe(true);
  });
});

describe('docs asset caching', () => {
  test('a hashed bundle is immutable for a year', async () => {
    const store = bucket({ '_site/docs/_astro/app.aYS1OYVv.css': 'body{}' });
    const res = await worker.fetch(
      get('https://agentkit.sbs/docs/_astro/app.aYS1OYVv.css'),
      env(store),
    );

    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  test('an unhashed asset revalidates', async () => {
    const store = bucket({ '_site/docs/pagefind/pagefind.js': 'js' });
    const res = await worker.fetch(get('https://agentkit.sbs/docs/pagefind/pagefind.js'), env(store));

    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  test('a document is never cached, so a deploy is verifiable', async () => {
    const store = bucket({ '_site/docs/index.html': '<h1>docs</h1>' });
    const res = await worker.fetch(get('https://agentkit.sbs/docs/'), env(store));

    expect(res.headers.get('cache-control')).toBeNull();
  });
});

describe('an html asset path is still a document', () => {
  test.each([
    'https://agentkit.sbs/docs/index.html',
    'https://agentkit.sbs/docs/getting-started/install/index.html',
  ])('%s carries the document headers, not bare asset headers', async (url) => {
    const key = `_site/${new URL(url).pathname.replace(/^\//, '')}`;
    const store = bucket({ [key]: '<h1>docs</h1>' });
    const res = await worker.fetch(get(url), env(store));
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('the relaxed docs policy cannot leak onto marketing pages', () => {
  // The apex serves its home page and its sub-pages from two different branches.
  // Asserting only the home page left the sub-page branch free to hand out the
  // docs policy with every test still green.
  test.each([
    ['https://agentkit.sbs/', '_site/index.html'],
    ['https://agentkit.sbs/install', '_site/install/index.html'],
    ['https://agentkit.sbs/docsomething', '_site/docsomething/index.html'],
  ])('%s keeps the strict policy', async (url, key) => {
    const store = bucket({ [key]: '<h1>marketing</h1>' });
    const res = await worker.fetch(get(url), env(store));
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(res.status).toBe(200);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain('wasm-unsafe-eval');
    expect(res.headers.get('cache-control')).toBeNull();
  });
});

describe('the docs listing is what makes pruning possible', () => {
  const seeded = {
    '_site/docs/index.html': 'a',
    '_site/docs/_astro/app.css': 'b',
    '_site/docs/pagefind/pagefind.js': 'c',
    '_site/index.html': 'marketing',
    'pages/deadbeef/index.html': 'a page',
  };

  test('a site token lists the docs subtree, and nothing outside it', async () => {
    const store = bucket(seeded);
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/site-list/docs/', {
        headers: { authorization: `Bearer ${SITE_TOKEN}` },
      }),
      env(store),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      prefix: 'docs/',
      keys: ['docs/_astro/app.css', 'docs/index.html', 'docs/pagefind/pagefind.js'],
    });
  });

  test.each([
    ['the publish token', PUBLISH_TOKEN],
    ['no token', null],
  ])('%s cannot list', async (_label, token) => {
    const store = bucket(seeded);
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/site-list/docs/', { headers }),
      env(store),
    );

    expect(res.status).toBe(401);
  });

  test('an unset site token fails closed', async () => {
    const store = bucket(seeded);
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/site-list/docs/', {
        headers: { authorization: 'Bearer ' },
      }),
      env(store, { SITE_TOKEN: undefined }),
    );

    expect(res.status).toBe(401);
  });

  // The router strips the trailing slash, so the prefix arrives as `docs`. Listing
  // on that would also match a sibling keyspace.
  test('a sibling keyspace is not swept in by the prefix', async () => {
    const store = bucket({
      '_site/docs/index.html': 'docs',
      '_site/docsy/index.html': 'not docs',
    });
    const res = await worker.fetch(
      new Request('https://agentkit.sbs/api/site-list/docs/', {
        headers: { authorization: `Bearer ${SITE_TOKEN}` },
      }),
      env(store),
    );

    expect((await res.json()).keys).toEqual(['docs/index.html']);
  });

  // Listing outside docs/ would expose the marketing keyspace to a token scoped
  // to the docs subtree everywhere else.
  test.each([
    'https://agentkit.sbs/api/site-list/',
    'https://agentkit.sbs/api/site-list/pages/',
    'https://agentkit.sbs/api/site-list/docsy/',
    'https://agentkit.sbs/api/site-list/../',
  ])('%s is refused', async (url) => {
    const store = bucket(seeded);
    const res = await worker.fetch(
      new Request(url, { headers: { authorization: `Bearer ${SITE_TOKEN}` } }),
      env(store),
    );

    expect(res.status).not.toBe(200);
  });
});
