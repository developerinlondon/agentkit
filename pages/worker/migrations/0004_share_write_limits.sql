-- Rate limiting for share writes authorized by page-access capabilities.
-- Unlike device_write_limits this table has no foreign key. Keys are hashed
-- user ids, so the table holds at most one permanently-reused row per user
-- who has ever used the share menu; nothing needs reaping.
CREATE TABLE share_write_limits (
  token_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
