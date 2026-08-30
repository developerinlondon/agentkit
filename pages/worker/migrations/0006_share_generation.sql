-- Derivable share links: the token becomes HMAC(SHARE_LINK_KEY, slug:generation),
-- so the current link is recomputable on demand instead of unrecoverable after
-- mint. `share_token_hash` stays for links minted before this scheme; rotating
-- or disabling clears it.
ALTER TABLE pages ADD COLUMN share_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN share_enabled INTEGER NOT NULL DEFAULT 0;
