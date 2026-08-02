ALTER TABLE device_authorizations
  ADD COLUMN scopes TEXT NOT NULL DEFAULT 'pages:write pages:delete';

ALTER TABLE device_tokens
  ADD COLUMN scopes TEXT NOT NULL DEFAULT 'pages:write pages:delete';

ALTER TABLE device_tokens
  ADD COLUMN expires_at INTEGER;

UPDATE device_tokens
SET expires_at = unixepoch() + 7776000
WHERE expires_at IS NULL;

CREATE TABLE device_write_limits (
  token_hash TEXT PRIMARY KEY REFERENCES device_tokens(token_hash) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0)
);
