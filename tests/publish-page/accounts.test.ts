import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { consumeDeviceWrite } from '../../pages/worker/src/accounts.js';
import worker from '../../pages/worker/src/worker.js';

const openDatabases: Database[] = [];
const ACCOUNT_URL = 'https://account.agentkit.sbs';
const PAGES_URL = 'https://pages.agentkit.sbs';

function d1() {
  const sqlite = new Database(':memory:');
  openDatabases.push(sqlite);
  const migrationsUrl = new URL('../../pages/worker/migrations/', import.meta.url);
  for (const migration of readdirSync(migrationsUrl).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.run(readFileSync(new URL(migration, migrationsUrl), 'utf8'));
  }
  return {
    sqlite,
    binding: {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) {
            values = next;
            return statement;
          },
          async first() {
            return sqlite.query(sql).get(...values);
          },
          async all() {
            return { results: sqlite.query(sql).all(...values) };
          },
          async run() {
            const result = sqlite.query(sql).run(...values);
            return { success: true, meta: { changes: result.changes } };
          },
        };
        return statement;
      },
    },
  };
}

function bucket() {
  const writes = new Map<string, { body: string }>();
  return {
    writes,
    async get(key: string) {
      return writes.get(key) ?? null;
    },
    async put(key: string, body: ArrayBuffer) {
      writes.set(key, { body: new TextDecoder().decode(body) });
    },
    async head(key: string) {
      return writes.has(key) ? {} : null;
    },
    async delete(key: string) {
      writes.delete(key);
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pkce(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(bytes).toString('base64url');
}

async function accountEnv() {
  const database = d1();
  const pages = bucket();
  const now = Math.floor(Date.now() / 1000);
  database.sqlite.run(
    'INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)',
    ['user-a', 'owner@example.com', 'Owner', now],
  );
  database.sqlite.run(
    'INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)',
    ['user-b', 'other@example.com', 'Other', now],
  );
  database.sqlite.run(
    `INSERT INTO device_tokens (token_hash, user_id, name, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [await digest('device-a'), 'user-a', 'MacBook', 'pages:write pages:delete', now + 3600, now],
  );
  database.sqlite.run(
    `INSERT INTO device_tokens (token_hash, user_id, name, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [await digest('device-b'), 'user-b', 'Other Mac', 'pages:write pages:delete', now + 3600, now],
  );
  database.sqlite.run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [await digest('session-a'), 'user-a', now + 3600, now],
  );
  database.sqlite.run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [await digest('session-b'), 'user-b', now + 3600, now],
  );
  return {
    database,
    pages,
    env: {
      DB: database.binding,
      PAGES: pages,
      SITE_TOKEN: 'site-secret',
      PUBLISH_TOKEN: 'legacy-shared-secret',
      ACCOUNT_MODE: 'required',
      ACCOUNT_URL,
      PAGES_URL,
      OIDC_ISSUER: 'https://auth.assay.rs/auth',
      OIDC_CLIENT_ID: 'agentkit-pages',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      SESSION_SECRET: 'session-secret',
    },
  };
}

function signedIn(url: string, session = 'session-a') {
  return new Request(url, { headers: { cookie: `agentkit_session=${session}` } });
}

function accountPost(url: string, body: unknown, session = 'session-a') {
  return new Request(url, {
    method: 'POST',
    headers: {
      cookie: `agentkit_session=${session}`,
      'content-type': 'application/json',
      origin: ACCOUNT_URL,
    },
    body: JSON.stringify(body),
  });
}

function publish(token: string, body = '<h1>private</h1>', slug = 'private-page', title?: string) {
  return new Request(`${ACCOUNT_URL}/api/pages/${slug}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      ...(title ? { 'x-page-title': encodeURIComponent(title) } : {}),
    },
    body,
  });
}

async function pageAccessUrl(
  setup: Awaited<ReturnType<typeof accountEnv>>,
  slug = 'private-page',
  session = 'session-a',
) {
  const response = await worker.fetch(
    signedIn(`${ACCOUNT_URL}/access?return_to=${encodeURIComponent(`${PAGES_URL}/${slug}`)}`, session),
    setup.env,
  );
  return { response, location: response.headers.get('location') };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('account and content origin isolation', () => {
  test('account controls are reachable only on the account origin', async () => {
    const setup = await accountEnv();

    expect((await worker.fetch(signedIn(`${ACCOUNT_URL}/dashboard`), setup.env)).status).toBe(200);
    expect((await worker.fetch(signedIn(`${PAGES_URL}/dashboard`), setup.env)).status).toBe(404);
    expect((await worker.fetch(
      new Request(`${PAGES_URL}/api/device/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_name: 'Hostile page origin' }),
      }),
      setup.env,
    )).status).toBe(404);
  });

  test('rendered pages are reachable only on the untrusted content origin', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);

    expect((await worker.fetch(signedIn(`${ACCOUNT_URL}/private-page`), setup.env)).status).toBe(404);
    const privatePage = await worker.fetch(new Request(`${PAGES_URL}/private-page`), setup.env);
    expect(privatePage.status).toBe(302);
    expect(privatePage.headers.get('location')).toBe(
      `${ACCOUNT_URL}/access?return_to=${encodeURIComponent(`${PAGES_URL}/private-page`)}`,
    );
  });

  test('Assay redirects back to the account origin, never the content origin', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/login?return_to=%2Fdashboard`),
      setup.env,
    );

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location')!);
    expect(target.searchParams.get('redirect_uri')).toBe(`${ACCOUNT_URL}/auth/callback`);
  });
});

describe('account publishing', () => {
  test('required account mode fails closed when D1 is missing', async () => {
    const pages = bucket();
    const response = await worker.fetch(
      publish('legacy-shared-secret'),
      {
        ACCOUNT_MODE: 'required',
        PAGES: pages,
        PUBLISH_TOKEN: 'legacy-shared-secret',
        SITE_TOKEN: 'site-secret',
      },
    );

    expect(response.status).toBe(503);
    expect(pages.writes.size).toBe(0);
  });

  test('account mode rejects the legacy shared publish token', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(publish('legacy-shared-secret'), setup.env);

    expect(response.status).toBe(401);
    expect(setup.pages.writes.size).toBe(0);
  });

  test('a device token creates a private page owned by its Assay user', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(publish('device-a'), setup.env);

    expect(response.status).toBe(200);
    expect(setup.pages.writes.get('pages/private-page/index.html')?.body).toBe('<h1>private</h1>');
    expect(
      setup.database.sqlite
        .query('SELECT owner_id, visibility FROM pages WHERE slug = ?')
        .get('private-page'),
    ).toEqual({ owner_id: 'user-a', visibility: 'private' });
  });

  test('device scopes independently authorize publishing and deletion', async () => {
    const setup = await accountEnv();
    const future = Math.floor(Date.now() / 1000) + 3600;
    setup.database.sqlite.run(
      "UPDATE device_tokens SET scopes = 'pages:write', expires_at = ? WHERE token_hash = ?",
      [future, await digest('device-a')],
    );

    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    expect((await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/private-page`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer device-a' },
      }),
      setup.env,
    )).status).toBe(403);

    setup.database.sqlite.run(
      "UPDATE device_tokens SET scopes = 'pages:delete' WHERE token_hash = ?",
      [await digest('device-a')],
    );
    expect((await worker.fetch(publish('device-a', '<h1>must not overwrite</h1>'), setup.env)).status).toBe(403);
    expect((await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/private-page`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer device-a' },
      }),
      setup.env,
    )).status).toBe(200);
  });

  test('expired device credentials fail closed', async () => {
    const setup = await accountEnv();
    setup.database.sqlite.run(
      'UPDATE device_tokens SET expires_at = 0 WHERE token_hash = ?',
      [await digest('device-a')],
    );

    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(401);
    expect(setup.pages.writes.size).toBe(0);
  });

  test('a token minted by the old Worker after migration remains valid for 90 days', async () => {
    const setup = await accountEnv();
    const createdAt = Math.floor(Date.now() / 1000);
    setup.database.sqlite.run(
      'INSERT INTO device_tokens (token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?)',
      [await digest('migration-gap-device'), 'user-a', 'Migration-gap Mac', createdAt],
    );

    expect((await worker.fetch(publish('migration-gap-device'), setup.env)).status).toBe(200);
    const dashboardBody = await (await worker.fetch(
      signedIn(`${ACCOUNT_URL}/dashboard`),
      setup.env,
    )).text();
    const derivedExpiry = new Date((createdAt + 90 * 24 * 60 * 60) * 1000).toISOString().slice(0, 10);
    expect(dashboardBody).toContain(`Migration-gap Mac`);
    expect(dashboardBody).toContain(`expires ${derivedExpiry}`);
  });

  test('a D1-backed per-device rate limit bounds publish and delete bursts', async () => {
    const setup = await accountEnv();
    setup.env.WRITE_RATE_LIMIT_PER_MINUTE = '2';

    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    expect((await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/private-page`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer device-a' },
      }),
      setup.env,
    )).status).toBe(200);
    const limited = await worker.fetch(publish('device-a'), setup.env);

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(setup.database.sqlite.query(
      'SELECT request_count FROM device_write_limits WHERE token_hash = ?',
    ).get(await digest('device-a'))).toEqual({ request_count: 3 });
  });

  test('the rate window follows D1 time instead of an out-of-order Worker clock', async () => {
    const setup = await accountEnv();
    setup.env.WRITE_RATE_LIMIT_PER_MINUTE = '2';
    const realNow = Date.now;
    const baseSeconds = Math.floor(realNow() / 1000 / 60) * 60;
    const rateWindowOffsets = [120, 60, 120];
    Date.now = () => (baseSeconds + rateWindowOffsets.shift()!) * 1000;
    try {
      const tokenHash = await digest('device-a');
      expect((await consumeDeviceWrite(setup.env, tokenHash)).allowed).toBe(true);
      expect((await consumeDeviceWrite(setup.env, tokenHash)).allowed).toBe(true);
      expect((await consumeDeviceWrite(setup.env, tokenHash)).allowed).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  test('a published title is stored and shown instead of the opaque slug', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(
      publish('device-a', '<h1>private</h1>', 'private-page', 'Quarterly Plan 🚀'),
      setup.env,
    )).status).toBe(200);

    expect(setup.database.sqlite.query('SELECT title FROM pages WHERE slug = ?').get('private-page'))
      .toEqual({ title: 'Quarterly Plan 🚀' });
    const response = await worker.fetch(signedIn(`${ACCOUNT_URL}/dashboard`), setup.env);
    expect(await response.text()).toContain('Quarterly Plan 🚀');
  });

  test('a different user cannot overwrite an owned page', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);

    const response = await worker.fetch(publish('device-b', '<h1>stolen</h1>'), setup.env);

    expect(response.status).toBe(403);
    expect(setup.pages.writes.get('pages/private-page/index.html')?.body).toBe('<h1>private</h1>');
  });

  test('an unauthenticated visitor cannot read a private page', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);

    const response = await worker.fetch(
      new Request('https://pages.agentkit.sbs/private-page'),
      setup.env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `${ACCOUNT_URL}/access?return_to=${encodeURIComponent(`${PAGES_URL}/private-page`)}`,
    );
  });

  test('new page creation stops at the configured per-user quota', async () => {
    const setup = await accountEnv();
    setup.env.MAX_PAGES_PER_USER = '1';
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);

    const response = await worker.fetch(publish('device-a', '<h1>second</h1>', 'second-page'), setup.env);

    expect(response.status).toBe(429);
    expect(setup.pages.writes.has('pages/second-page/index.html')).toBe(false);
  });

  test('only the owner can delete page metadata and content', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const other = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/private-page`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer device-b' },
      }),
      setup.env,
    );
    expect(other.status).toBe(403);
    expect(setup.pages.writes.has('pages/private-page/index.html')).toBe(true);

    const owner = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/private-page`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer device-a' },
      }),
      setup.env,
    );
    expect(owner.status).toBe(200);
    expect(setup.pages.writes.has('pages/private-page/index.html')).toBe(false);
    expect(setup.database.sqlite.query('SELECT slug FROM pages WHERE slug = ?').get('private-page'))
      .toBeNull();
  });

  test('a missing R2 object does not silently discard its metadata', async () => {
    const setup = await accountEnv();
    const now = Math.floor(Date.now() / 1000);
    setup.database.sqlite.run(
      "INSERT INTO pages (slug, owner_id, visibility, created_at, updated_at) VALUES (?, ?, 'private', ?, ?)",
      ['missing-body', 'user-a', now, now],
    );

    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/missing-body`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer device-a' },
      }),
      setup.env,
    );

    expect(response.status).toBe(404);
    expect(setup.database.sqlite.query('SELECT slug FROM pages WHERE slug = ?').get('missing-body'))
      .toEqual({ slug: 'missing-body' });
  });
});

describe('private access and sharing', () => {
  test('the account origin mints a short-lived page-scoped access URL for an owner', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    expect((await worker.fetch(
      publish('device-a', '<h1>another private page</h1>', 'another-page'),
      setup.env,
    )).status).toBe(200);

    const access = await worker.fetch(
      signedIn(
        `${ACCOUNT_URL}/access?return_to=${encodeURIComponent(`${PAGES_URL}/private-page`)}`,
      ),
      setup.env,
    );

    expect(access.status).toBe(302);
    const location = access.headers.get('location')!;
    expect(location).toStartWith(`${PAGES_URL}/private-page?access=`);
    const page = await worker.fetch(new Request(location), setup.env);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<h1>private</h1>');

    expect((await worker.fetch(
      new Request(location.replace('/private-page?', '/another-page?')),
      setup.env,
    )).status).toBe(302);
  });

  test('an expired account-issued capability cannot read its page', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const { location } = await pageAccessUrl(setup);
    setup.database.sqlite.run('UPDATE page_access_tokens SET expires_at = 0');

    expect((await worker.fetch(new Request(location!), setup.env)).status).toBe(302);
  });

  test('page access is denied to another account until its verified email is invited', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const target = `${ACCOUNT_URL}/access?return_to=${encodeURIComponent(`${PAGES_URL}/private-page`)}`;

    expect((await worker.fetch(signedIn(target, 'session-b'), setup.env)).status).toBe(404);

    expect((await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/pages/private-page/invites`, { email: 'other@example.com' }),
      setup.env,
    )).status).toBe(200);
    const invited = await worker.fetch(signedIn(target, 'session-b'), setup.env);
    expect(invited.status).toBe(302);
    expect((await worker.fetch(new Request(invited.headers.get('location')!), setup.env)).status)
      .toBe(200);
  });

  test('the owner can read its private page through an account-issued access URL', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);

    const access = await pageAccessUrl(setup);
    expect(access.response.status).toBe(302);
    const response = await worker.fetch(new Request(access.location!), setup.env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>private</h1>');
  });

  test('a share link grants access and disabling it revokes the old URL', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const enabled = await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/pages/private-page/share`, { enabled: true }),
      setup.env,
    );
    expect(enabled.status).toBe(200);
    const { url } = await enabled.json() as { url: string };

    expect((await worker.fetch(new Request(url), setup.env)).status).toBe(200);

    const disabled = await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/pages/private-page/share`, { enabled: false }),
      setup.env,
    );
    expect(disabled.status).toBe(200);
    expect((await worker.fetch(new Request(url), setup.env)).status).toBe(302);
  });

  test('an invited Assay email can obtain page-scoped access after signing in', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const invited = await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/pages/private-page/invites`, {
        email: 'OTHER@example.com',
      }),
      setup.env,
    );
    expect(invited.status).toBe(200);

    const access = await pageAccessUrl(setup, 'private-page', 'session-b');
    expect(access.response.status).toBe(302);
    const response = await worker.fetch(new Request(access.location!), setup.env);
    expect(response.status).toBe(200);
  });

  test('the owner can revoke an email invite', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    expect((await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/pages/private-page/invites`, {
        email: 'other@example.com',
      }),
      setup.env,
    )).status).toBe(200);
    const access = await pageAccessUrl(setup, 'private-page', 'session-b');
    expect((await worker.fetch(new Request(access.location!), setup.env)).status).toBe(200);

    const removed = await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/pages/private-page/invites/remove`, {
        email: 'other@example.com',
      }),
      setup.env,
    );

    expect(removed.status).toBe(200);
    expect((await pageAccessUrl(setup, 'private-page', 'session-b')).response.status).toBe(404);
    expect((await worker.fetch(new Request(access.location!), setup.env)).status).toBe(302);
  });

  test('the access broker rejects targets outside the configured content origin', async () => {
    const setup = await accountEnv();
    const malicious = encodeURIComponent('https://attacker.example/private-page');

    expect((await worker.fetch(
      signedIn(`${ACCOUNT_URL}/access?return_to=${malicious}`),
      setup.env,
    )).status).toBe(400);
  });

  test('the dashboard shows the email addresses that currently have access', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    expect((await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/pages/private-page/invites`, {
        email: 'other@example.com',
      }),
      setup.env,
    )).status).toBe(200);

    const response = await worker.fetch(signedIn(`${ACCOUNT_URL}/dashboard`), setup.env);
    expect(await response.text()).toContain('Access: other@example.com');
  });

  test('the dashboard lists only the signed-in owner pages', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);

    const owner = await worker.fetch(signedIn(`${ACCOUNT_URL}/dashboard`), setup.env);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain('private-page');

    const other = await worker.fetch(
      signedIn(`${ACCOUNT_URL}/dashboard`, 'session-b'),
      setup.env,
    );
    expect(other.status).toBe(200);
    expect(await other.text()).not.toContain('private-page');
  });

  test('dashboard controls can submit only to the same origin', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    // Revoke renders per granted email: with no grants there is nothing to revoke.
    const grant = accountPost(`${ACCOUNT_URL}/api/pages/private-page/invites`, { email: 'other@example.com' });
    expect((await worker.fetch(grant, setup.env)).status).toBe(200);
    const response = await worker.fetch(signedIn(`${ACCOUNT_URL}/dashboard`), setup.env);

    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
    // Under `no-referrer` a browser sends `Origin: null` on a same-origin form
    // POST, which the check below then rejects — every control 403s in a real
    // browser while every test that sets the header by hand still passes.
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const body = await response.text();
    expect(body).toContain('/api/pages/private-page/invites/remove');
    expect(body).toContain('value="other@example.com"');
  });

  test('an opaque origin cannot drive a dashboard control', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/private-page/share`, {
        method: 'POST',
        headers: {
          cookie: 'agentkit_session=session-a',
          origin: 'null',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ enabled: 'true' }),
      }),
      setup.env,
    );
    expect(response.status).toBe(403);
  });

  test('the dashboard share form displays the new one-time link', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/private-page/share`, {
        method: 'POST',
        headers: {
          cookie: 'agentkit_session=session-a',
          origin: ACCOUNT_URL,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ enabled: 'true' }),
      }),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('https://pages.agentkit.sbs/private-page?share=');
  });

  test('a cross-origin request cannot change sharing', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/pages/private-page/share`, {
        method: 'POST',
        headers: {
          cookie: 'agentkit_session=session-a',
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: true }),
      }),
      setup.env,
    );

    expect(response.status).toBe(403);
    expect(setup.database.sqlite.query('SELECT share_token_hash FROM pages WHERE slug = ?').get('private-page'))
      .toEqual({ share_token_hash: null });
  });
});

describe('device authorization', () => {
  test('the dashboard lists device credentials and lets their owner revoke one', async () => {
    const setup = await accountEnv();
    const tokenHash = await digest('device-a');
    setup.database.sqlite.run(
      `INSERT INTO device_tokens (token_hash, user_id, name, scopes, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [await digest('unsafe-device'), 'user-a', '<script>alert(1)</script>', 'pages:write', 2, 1],
    );
    const dashboardResponse = await worker.fetch(
      signedIn(`${ACCOUNT_URL}/dashboard`),
      setup.env,
    );
    const dashboardBody = await dashboardResponse.text();
    expect(dashboardBody).toContain('MacBook');
    expect(dashboardBody).toContain('pages:write');
    expect(dashboardBody).toContain('pages:delete');
    expect(dashboardBody).toContain('expires');
    expect(dashboardBody).toContain(`/api/devices/${tokenHash}/revoke`);
    expect(dashboardBody).not.toContain('<script>alert(1)</script>');
    expect(dashboardBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    const wrongUser = await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/devices/${tokenHash}/revoke`, {}, 'session-b'),
      setup.env,
    );
    expect(wrongUser.status).toBe(404);

    const crossOrigin = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/devices/${tokenHash}/revoke`, {
        method: 'POST',
        headers: {
          cookie: 'agentkit_session=session-a',
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      setup.env,
    );
    expect(crossOrigin.status).toBe(403);

    const revoked = await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/devices/${tokenHash}/revoke`, {}),
      setup.env,
    );
    expect(revoked.status).toBe(200);
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(401);
    expect((await worker.fetch(publish('device-b'), setup.env)).status).toBe(200);
  });

  test('starting authorization removes expired device grants', async () => {
    const setup = await accountEnv();
    setup.database.sqlite.run(
      `INSERT INTO device_authorizations
         (device_hash, user_code_hash, device_name, status, expires_at, interval_seconds)
       VALUES ('expired-device', 'expired-code', 'Old Mac', 'pending', 1, 5)`,
    );

    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/device/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_name: 'New Mac' }),
      }),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(setup.database.sqlite.query(
      'SELECT COUNT(*) AS count FROM device_authorizations WHERE expires_at <= ?',
    ).get(Math.floor(Date.now() / 1000))).toEqual({ count: 0 });
  });

  test('a signed-in user approves a short code and the CLI receives one device token', async () => {
    const setup = await accountEnv();
    const started = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/device/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_name: 'New Mac', scopes: ['pages:write'] }),
      }),
      setup.env,
    );
    expect(started.status).toBe(200);
    const authorization = await started.json() as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      interval: number;
    };
    expect(authorization.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(authorization.verification_uri_complete).toContain(authorization.user_code);
    expect(authorization.interval).toBeGreaterThanOrEqual(5);

    const approved = await worker.fetch(
      accountPost(`${ACCOUNT_URL}/api/device/approve`, {
        user_code: authorization.user_code,
      }),
      setup.env,
    );
    expect(approved.status).toBe(200);

    const tokenResponse = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: authorization.device_code }),
      }),
      setup.env,
    );
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as {
      access_token: string;
      token_type: string;
      scope: string;
      expires_in: number;
    };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.access_token.length).toBeGreaterThan(30);
    expect(tokenBody.scope).toBe('pages:write');
    expect(tokenBody.expires_in).toBeGreaterThan(0);
    expect(setup.database.sqlite.query(
      'SELECT scopes, expires_at > ? AS active FROM device_tokens WHERE token_hash = ?',
    ).get(Math.floor(Date.now() / 1000), await digest(tokenBody.access_token)))
      .toEqual({ scopes: 'pages:write', active: 1 });

    const publishResponse = await worker.fetch(publish(tokenBody.access_token), setup.env);
    expect(publishResponse.status).toBe(200);

    const replay = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: authorization.device_code }),
      }),
      setup.env,
    );
    expect(replay.status).toBe(400);
  });

  test('device authorization rejects unsupported scopes', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/device/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_name: 'Unknown client', scopes: ['pages:admin'] }),
      }),
      setup.env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_scope' });
  });

  test('pending polls are bounded by the advertised interval', async () => {
    const setup = await accountEnv();
    const started = await worker.fetch(
      new Request(`${ACCOUNT_URL}/api/device/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_name: 'New Mac' }),
      }),
      setup.env,
    );
    const { device_code } = await started.json() as { device_code: string };
    const poll = () => worker.fetch(
      new Request(`${ACCOUNT_URL}/api/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code }),
      }),
      setup.env,
    );

    const pending = await poll();
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: 'authorization_pending' });
    const tooFast = await poll();
    expect(tooFast.status).toBe(429);
    expect(await tooFast.json()).toEqual({ error: 'slow_down' });
  });

  test('the verification page requires an Assay session', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/device?user_code=ABCD-2345`),
      setup.env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/login?return_to=');
  });

  test('the verification page escapes a code before rendering it', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      signedIn(`${ACCOUNT_URL}/device?user_code=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E`),
      setup.env,
    );
    const body = await response.text();

    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

describe('Assay OIDC sessions', () => {
  test('starting login removes expired OIDC states', async () => {
    const setup = await accountEnv();
    setup.database.sqlite.run(
      "INSERT INTO oauth_states (state_hash, verifier, return_to, expires_at) VALUES ('old', 'old', '/', 1)",
    );

    const response = await worker.fetch(new Request(`${ACCOUNT_URL}/login`), setup.env);

    expect(response.status).toBe(302);
    expect(setup.database.sqlite.query('SELECT COUNT(*) AS count FROM oauth_states WHERE expires_at <= ?')
      .get(Math.floor(Date.now() / 1000))).toEqual({ count: 0 });
  });

  test('login fails closed when the confidential OIDC client is incomplete', async () => {
    const setup = await accountEnv();
    setup.env.OIDC_CLIENT_SECRET = '';

    const response = await worker.fetch(new Request(`${ACCOUNT_URL}/login`), setup.env);

    expect(response.status).toBe(503);
  });

  test('login starts an authorization-code flow with PKCE and a one-time state', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/login?return_to=%2Fdashboard`),
      setup.env,
    );

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location')!);
    expect(`${target.origin}${target.pathname}`).toBe('https://auth.assay.rs/auth/authorize');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('client_id')).toBe('agentkit-pages');
    expect(target.searchParams.get('redirect_uri')).toBe(`${ACCOUNT_URL}/auth/callback`);
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('code_challenge')?.length).toBeGreaterThan(30);
    const state = target.searchParams.get('state')!;
    const saved = setup.database.sqlite
      .query('SELECT return_to, verifier FROM oauth_states WHERE state_hash = ?')
      .get(await digest(state)) as { return_to: string; verifier: string };
    expect(saved.return_to).toBe('/dashboard');
    expect(target.searchParams.get('code_challenge')).toBe(await pkce(saved.verifier));
  });

  test('login rejects a protocol-relative return target', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/login?return_to=%2F%2Fattacker.example`),
      setup.env,
    );
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;

    expect(setup.database.sqlite.query('SELECT return_to FROM oauth_states WHERE state_hash = ?')
      .get(await digest(state))).toEqual({ return_to: '/dashboard' });
  });

  test('callback verifies userinfo and creates an opaque local session', async () => {
    const setup = await accountEnv();
    const login = await worker.fetch(
      new Request(`${ACCOUNT_URL}/login?return_to=%2Fdashboard`),
      setup.env,
    );
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const calls: Request[] = [];
    setup.env.OIDC_FETCH = async (request: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(request, init);
      calls.push(incoming);
      if (incoming.url.endsWith('/token')) {
        expect(await incoming.text()).toContain('code_verifier=');
        return Response.json({ access_token: 'assay-access', token_type: 'Bearer' });
      }
      expect(incoming.headers.get('authorization')).toBe('Bearer assay-access');
      return Response.json({
        sub: 'assay-user-1',
        email: 'new@example.com',
        email_verified: true,
        name: 'New User',
      });
    };

    const callback = await worker.fetch(
      new Request(`${ACCOUNT_URL}/auth/callback?code=oidc-code&state=${state}`),
      setup.env,
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/dashboard');
    expect(calls.map((call) => call.url)).toEqual([
      'https://auth.assay.rs/auth/token',
      'https://auth.assay.rs/auth/userinfo',
    ]);
    const cookie = callback.headers.get('set-cookie')!;
    expect(cookie).toContain('agentkit_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
    expect(setup.database.sqlite.query('SELECT email FROM users WHERE id = ?').get('assay-user-1'))
      .toEqual({ email: 'new@example.com' });
    expect(setup.database.sqlite.query('SELECT COUNT(*) AS count FROM oauth_states').get())
      .toEqual({ count: 0 });
  });

  test('callback rejects an unverified Assay email', async () => {
    const setup = await accountEnv();
    const login = await worker.fetch(new Request(`${ACCOUNT_URL}/login`), setup.env);
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    setup.env.OIDC_FETCH = async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/token')) return Response.json({ access_token: 'access' });
      return Response.json({ sub: 'unverified', email: 'no@example.com', email_verified: false });
    };

    const callback = await worker.fetch(
      new Request(`${ACCOUNT_URL}/auth/callback?code=code&state=${state}`),
      setup.env,
    );

    expect(callback.status).toBe(403);
    expect(callback.headers.get('set-cookie')).toBeNull();
  });

  test('logout revokes the local session and clears its cookie', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      new Request(`${ACCOUNT_URL}/logout`, {
        method: 'POST',
        headers: {
          cookie: 'agentkit_session=session-a',
          origin: ACCOUNT_URL,
        },
      }),
      setup.env,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(
      setup.database.sqlite.query('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get('user-a'),
    ).toEqual({ count: 0 });
  });
});
