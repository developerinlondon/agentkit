import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../../pages/worker/src/worker.js';

export const openDatabases: Database[] = [];
export const ACCOUNT_URL = 'https://account.agentkit.sbs';
export const PAGES_URL = 'https://pages.agentkit.sbs';

export function d1() {
  const sqlite = new Database(':memory:');
  // D1 enforces foreign keys on every query; bun:sqlite defaults them off.
  sqlite.run('PRAGMA foreign_keys = ON');
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

export function bucket() {
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

export async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function pkce(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(bytes).toString('base64url');
}

export async function accountEnv() {
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
    [await digest('device-a'), 'user-a', 'MacBook', 'pages:write pages:delete pages:share', now + 3600, now],
  );
  database.sqlite.run(
    `INSERT INTO device_tokens (token_hash, user_id, name, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [await digest('device-a-legacy'), 'user-a', 'Old MacBook', 'pages:write pages:delete', now + 3600, now],
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
  // Loosely typed on purpose: tests override optional Worker vars (rate
  // limits, quotas, OIDC fetch stubs) that the base literal never carries.
  const env: Record<string, unknown> = {
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
      SHARE_LINK_KEY: 'test-share-key',
  };
  return { database, pages, env };
}

export function signedIn(url: string, session = 'session-a') {
  return new Request(url, { headers: { cookie: `agentkit_session=${session}` } });
}

export function accountPost(url: string, body: unknown, session = 'session-a') {
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

export function publish(token: string, body = '<h1>private</h1>', slug = 'private-page', title?: string) {
  return new Request(`${ACCOUNT_URL}/api/pages/${slug}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      ...(title ? { 'x-page-title': encodeURIComponent(title) } : {}),
    },
    body,
  });
}

export async function pageAccessUrl(
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
