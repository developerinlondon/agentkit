import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import worker from '../../pages/worker/src/worker.js';

const openDatabases: Database[] = [];

function d1() {
  const sqlite = new Database(':memory:');
  openDatabases.push(sqlite);
  sqlite.run(readFileSync(new URL('../../pages/worker/migrations/0001_accounts.sql', import.meta.url), 'utf8'));
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
    'INSERT INTO device_tokens (token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?)',
    [await digest('device-a'), 'user-a', 'MacBook', now],
  );
  database.sqlite.run(
    'INSERT INTO device_tokens (token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?)',
    [await digest('device-b'), 'user-b', 'Other Mac', now],
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
      PUBLIC_URL: 'https://pages.agentkit.sbs',
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
      origin: 'https://pages.agentkit.sbs',
    },
    body: JSON.stringify(body),
  });
}

function publish(token: string, body = '<h1>private</h1>', slug = 'private-page', title?: string) {
  return new Request(`https://pages.agentkit.sbs/api/pages/${slug}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      ...(title ? { 'x-page-title': encodeURIComponent(title) } : {}),
    },
    body,
  });
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
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

  test('a published title is stored and shown instead of the opaque slug', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(
      publish('device-a', '<h1>private</h1>', 'private-page', 'Quarterly Plan 🚀'),
      setup.env,
    )).status).toBe(200);

    expect(setup.database.sqlite.query('SELECT title FROM pages WHERE slug = ?').get('private-page'))
      .toEqual({ title: 'Quarterly Plan 🚀' });
    const response = await worker.fetch(signedIn('https://pages.agentkit.sbs/dashboard'), setup.env);
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
    expect(response.headers.get('location')).toBe('/login?return_to=%2Fprivate-page');
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
      new Request('https://pages.agentkit.sbs/api/pages/private-page', {
        method: 'DELETE',
        headers: { authorization: 'Bearer device-b' },
      }),
      setup.env,
    );
    expect(other.status).toBe(403);
    expect(setup.pages.writes.has('pages/private-page/index.html')).toBe(true);

    const owner = await worker.fetch(
      new Request('https://pages.agentkit.sbs/api/pages/private-page', {
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
      new Request('https://pages.agentkit.sbs/api/pages/missing-body', {
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
  test('the owner session can read its private page', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);

    const response = await worker.fetch(
      signedIn('https://pages.agentkit.sbs/private-page'),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>private</h1>');
  });

  test('a share link grants access and disabling it revokes the old URL', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const enabled = await worker.fetch(
      accountPost('https://pages.agentkit.sbs/api/pages/private-page/share', { enabled: true }),
      setup.env,
    );
    expect(enabled.status).toBe(200);
    const { url } = await enabled.json() as { url: string };

    expect((await worker.fetch(new Request(url), setup.env)).status).toBe(200);

    const disabled = await worker.fetch(
      accountPost('https://pages.agentkit.sbs/api/pages/private-page/share', { enabled: false }),
      setup.env,
    );
    expect(disabled.status).toBe(200);
    expect((await worker.fetch(new Request(url), setup.env)).status).toBe(302);
  });

  test('an invited Assay email can read after signing in', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const invited = await worker.fetch(
      accountPost('https://pages.agentkit.sbs/api/pages/private-page/invites', {
        email: 'OTHER@example.com',
      }),
      setup.env,
    );
    expect(invited.status).toBe(200);

    const response = await worker.fetch(
      signedIn('https://pages.agentkit.sbs/private-page', 'session-b'),
      setup.env,
    );
    expect(response.status).toBe(200);
  });

  test('the owner can revoke an email invite', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    expect((await worker.fetch(
      accountPost('https://pages.agentkit.sbs/api/pages/private-page/invites', {
        email: 'other@example.com',
      }),
      setup.env,
    )).status).toBe(200);

    const removed = await worker.fetch(
      accountPost('https://pages.agentkit.sbs/api/pages/private-page/invites/remove', {
        email: 'other@example.com',
      }),
      setup.env,
    );

    expect(removed.status).toBe(200);
    expect((await worker.fetch(
      signedIn('https://pages.agentkit.sbs/private-page', 'session-b'),
      setup.env,
    )).status).toBe(302);
  });

  test('the dashboard shows the email addresses that currently have access', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    expect((await worker.fetch(
      accountPost('https://pages.agentkit.sbs/api/pages/private-page/invites', {
        email: 'other@example.com',
      }),
      setup.env,
    )).status).toBe(200);

    const response = await worker.fetch(signedIn('https://pages.agentkit.sbs/dashboard'), setup.env);
    expect(await response.text()).toContain('Access: other@example.com');
  });

  test('the dashboard lists only the signed-in owner pages', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);

    const owner = await worker.fetch(signedIn('https://pages.agentkit.sbs/dashboard'), setup.env);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain('private-page');

    const other = await worker.fetch(
      signedIn('https://pages.agentkit.sbs/dashboard', 'session-b'),
      setup.env,
    );
    expect(other.status).toBe(200);
    expect(await other.text()).not.toContain('private-page');
  });

  test('dashboard controls can submit only to the same origin', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const response = await worker.fetch(signedIn('https://pages.agentkit.sbs/dashboard'), setup.env);

    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(await response.text()).toContain('/api/pages/private-page/invites/remove');
  });

  test('the dashboard share form displays the new one-time link', async () => {
    const setup = await accountEnv();
    expect((await worker.fetch(publish('device-a'), setup.env)).status).toBe(200);
    const response = await worker.fetch(
      new Request('https://pages.agentkit.sbs/api/pages/private-page/share', {
        method: 'POST',
        headers: {
          cookie: 'agentkit_session=session-a',
          origin: 'https://pages.agentkit.sbs',
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
      new Request('https://pages.agentkit.sbs/api/pages/private-page/share', {
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
      'INSERT INTO device_tokens (token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?)',
      [await digest('unsafe-device'), 'user-a', '<script>alert(1)</script>', 1],
    );
    const dashboardResponse = await worker.fetch(
      signedIn('https://pages.agentkit.sbs/dashboard'),
      setup.env,
    );
    const dashboardBody = await dashboardResponse.text();
    expect(dashboardBody).toContain('MacBook');
    expect(dashboardBody).toContain(`/api/devices/${tokenHash}/revoke`);
    expect(dashboardBody).not.toContain('<script>alert(1)</script>');
    expect(dashboardBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    const wrongUser = await worker.fetch(
      accountPost(`https://pages.agentkit.sbs/api/devices/${tokenHash}/revoke`, {}, 'session-b'),
      setup.env,
    );
    expect(wrongUser.status).toBe(404);

    const crossOrigin = await worker.fetch(
      new Request(`https://pages.agentkit.sbs/api/devices/${tokenHash}/revoke`, {
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
      accountPost(`https://pages.agentkit.sbs/api/devices/${tokenHash}/revoke`, {}),
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
      new Request('https://pages.agentkit.sbs/api/device/authorize', {
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
      new Request('https://pages.agentkit.sbs/api/device/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_name: 'New Mac' }),
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
      accountPost('https://pages.agentkit.sbs/api/device/approve', {
        user_code: authorization.user_code,
      }),
      setup.env,
    );
    expect(approved.status).toBe(200);

    const tokenResponse = await worker.fetch(
      new Request('https://pages.agentkit.sbs/api/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: authorization.device_code }),
      }),
      setup.env,
    );
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as { access_token: string; token_type: string };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.access_token.length).toBeGreaterThan(30);

    const publishResponse = await worker.fetch(publish(tokenBody.access_token), setup.env);
    expect(publishResponse.status).toBe(200);

    const replay = await worker.fetch(
      new Request('https://pages.agentkit.sbs/api/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: authorization.device_code }),
      }),
      setup.env,
    );
    expect(replay.status).toBe(400);
  });

  test('pending polls are bounded by the advertised interval', async () => {
    const setup = await accountEnv();
    const started = await worker.fetch(
      new Request('https://pages.agentkit.sbs/api/device/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_name: 'New Mac' }),
      }),
      setup.env,
    );
    const { device_code } = await started.json() as { device_code: string };
    const poll = () => worker.fetch(
      new Request('https://pages.agentkit.sbs/api/device/token', {
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
      new Request('https://pages.agentkit.sbs/device?user_code=ABCD-2345'),
      setup.env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/login?return_to=');
  });

  test('the verification page escapes a code before rendering it', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      signedIn('https://pages.agentkit.sbs/device?user_code=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E'),
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

    const response = await worker.fetch(new Request('https://pages.agentkit.sbs/login'), setup.env);

    expect(response.status).toBe(302);
    expect(setup.database.sqlite.query('SELECT COUNT(*) AS count FROM oauth_states WHERE expires_at <= ?')
      .get(Math.floor(Date.now() / 1000))).toEqual({ count: 0 });
  });

  test('login fails closed when the confidential OIDC client is incomplete', async () => {
    const setup = await accountEnv();
    setup.env.OIDC_CLIENT_SECRET = '';

    const response = await worker.fetch(new Request('https://pages.agentkit.sbs/login'), setup.env);

    expect(response.status).toBe(503);
  });

  test('login starts an authorization-code flow with PKCE and a one-time state', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      new Request('https://pages.agentkit.sbs/login?return_to=%2Fdashboard'),
      setup.env,
    );

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location')!);
    expect(`${target.origin}${target.pathname}`).toBe('https://auth.assay.rs/auth/authorize');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('client_id')).toBe('agentkit-pages');
    expect(target.searchParams.get('redirect_uri')).toBe('https://pages.agentkit.sbs/auth/callback');
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
      new Request('https://pages.agentkit.sbs/login?return_to=%2F%2Fattacker.example'),
      setup.env,
    );
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;

    expect(setup.database.sqlite.query('SELECT return_to FROM oauth_states WHERE state_hash = ?')
      .get(await digest(state))).toEqual({ return_to: '/dashboard' });
  });

  test('callback verifies userinfo and creates an opaque local session', async () => {
    const setup = await accountEnv();
    const login = await worker.fetch(
      new Request('https://pages.agentkit.sbs/login?return_to=%2Fdashboard'),
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
      new Request(`https://pages.agentkit.sbs/auth/callback?code=oidc-code&state=${state}`),
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
    expect(setup.database.sqlite.query('SELECT email FROM users WHERE id = ?').get('assay-user-1'))
      .toEqual({ email: 'new@example.com' });
    expect(setup.database.sqlite.query('SELECT COUNT(*) AS count FROM oauth_states').get())
      .toEqual({ count: 0 });
  });

  test('callback rejects an unverified Assay email', async () => {
    const setup = await accountEnv();
    const login = await worker.fetch(new Request('https://pages.agentkit.sbs/login'), setup.env);
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    setup.env.OIDC_FETCH = async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/token')) return Response.json({ access_token: 'access' });
      return Response.json({ sub: 'unverified', email: 'no@example.com', email_verified: false });
    };

    const callback = await worker.fetch(
      new Request(`https://pages.agentkit.sbs/auth/callback?code=code&state=${state}`),
      setup.env,
    );

    expect(callback.status).toBe(403);
    expect(callback.headers.get('set-cookie')).toBeNull();
  });

  test('logout revokes the local session and clears its cookie', async () => {
    const setup = await accountEnv();
    const response = await worker.fetch(
      new Request('https://pages.agentkit.sbs/logout', {
        method: 'POST',
        headers: {
          cookie: 'agentkit_session=session-a',
          origin: 'https://pages.agentkit.sbs',
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
