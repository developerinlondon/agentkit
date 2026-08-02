import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

const migrationsUrl = new URL('../../pages/worker/migrations/', import.meta.url);

test('forward migrations repair an already-recorded squashed accounts migration', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.run(readFileSync(new URL('0001_accounts.sql', migrationsUrl), 'utf8'));
    sqlite.run('DROP INDEX page_access_tokens_expiry; DROP TABLE page_access_tokens;');

    for (const migration of readdirSync(migrationsUrl).filter((name) => name > '0001_accounts.sql').sort()) {
      sqlite.run(readFileSync(new URL(migration, migrationsUrl), 'utf8'));
    }

    const table = sqlite.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'page_access_tokens'",
    ).get();
    const indexes = sqlite.query("PRAGMA index_list('page_access_tokens')").all() as { name: string }[];

    expect(table).not.toBeNull();
    expect(indexes.map(({ name }) => name)).toContain('page_access_tokens_expiry');

    sqlite.run(
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('user-a', 'owner@example.com', 'Owner', 1)",
    );
    sqlite.run("INSERT INTO pages (slug, owner_id, created_at, updated_at) VALUES ('page-a', 'user-a', 1, 1)");
    const upsert = sqlite.prepare(`
      INSERT INTO page_access_tokens (token_hash, page_slug, user_id, expires_at, created_at)
      VALUES (?, 'page-a', 'user-a', ?, 1)
      ON CONFLICT(page_slug, user_id) DO UPDATE SET
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `);
    upsert.run('token-a', 2);
    upsert.run('token-b', 3);

    expect(sqlite.query(
      "SELECT token_hash, expires_at FROM page_access_tokens WHERE page_slug = 'page-a' AND user_id = 'user-a'",
    ).all()).toEqual([{ token_hash: 'token-b', expires_at: 3 }]);
  } finally {
    sqlite.close();
  }
});
