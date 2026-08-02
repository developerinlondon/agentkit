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
  } finally {
    sqlite.close();
  }
});
