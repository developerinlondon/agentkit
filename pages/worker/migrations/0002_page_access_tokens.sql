CREATE TABLE IF NOT EXISTS page_access_tokens (
  token_hash TEXT PRIMARY KEY,
  page_slug TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (page_slug, user_id)
);

CREATE INDEX IF NOT EXISTS page_access_tokens_expiry ON page_access_tokens(expires_at);
