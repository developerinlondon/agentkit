CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX sessions_user_id ON sessions(user_id);

CREATE TABLE device_authorizations (
  device_hash TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  interval_seconds INTEGER NOT NULL,
  last_polled_at INTEGER
);

CREATE TABLE device_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX device_tokens_user_id ON device_tokens(user_id);

CREATE TABLE pages (
  slug TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  share_token_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX pages_owner_id ON pages(owner_id, updated_at DESC);

CREATE TABLE page_invites (
  page_slug TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_slug, email)
);
