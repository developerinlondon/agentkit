-- Rate limiting for share writes authorized by page-access capabilities.
-- Unlike device_write_limits this table has no foreign key: access tokens
-- live in page_access_tokens and expire in minutes, so rows are reaped by
-- window age instead of cascading from a parent credential.
CREATE TABLE share_write_limits (
  token_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
