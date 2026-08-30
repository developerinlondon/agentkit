const encoder = new TextEncoder();

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deviceCredential(env, token) {
  if (!env.DB || !token) return null;
  const tokenHash = await sha256(token);
  const credential = await env.DB.prepare(
    `SELECT users.id, users.email, users.display_name, device_tokens.scopes
       FROM device_tokens
       JOIN users ON users.id = device_tokens.user_id
      WHERE device_tokens.token_hash = ?
        AND device_tokens.revoked_at IS NULL
        AND COALESCE(device_tokens.expires_at, device_tokens.created_at + 7776000) > ?`,
  ).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  if (!credential) return null;
  await env.DB.prepare("UPDATE device_tokens SET last_used_at = ? WHERE token_hash = ?")
    .bind(Math.floor(Date.now() / 1000), tokenHash).run();
  return {
    tokenHash,
    scopes: String(credential.scopes).split(/\s+/).filter(Boolean),
    user: { id: credential.id, email: credential.email, display_name: credential.display_name },
  };
}

export async function consumeDeviceWrite(env, tokenHash, table = "device_write_limits") {
  const configured = Number(env.WRITE_RATE_LIMIT_PER_MINUTE || 60);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 60;
  const result = await env.DB.prepare(
    `INSERT INTO ${table} (token_hash, window_start, request_count)
     VALUES (?, unixepoch() - (unixepoch() % 60), 1)
     ON CONFLICT(token_hash) DO UPDATE SET
       request_count = CASE
         WHEN window_start = excluded.window_start
         THEN request_count + 1
         ELSE 1
       END,
       window_start = excluded.window_start
     RETURNING request_count,
               MAX(1, window_start + 60 - unixepoch()) AS retry_after`,
  ).bind(tokenHash).first();
  return {
    allowed: result.request_count <= limit,
    retryAfter: result.retry_after,
  };
}

function cookie(request, name) {
  const prefix = `${name}=`;
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

export async function sessionUser(request, env) {
  if (!env.DB) return null;
  const token = cookie(request, "agentkit_session");
  if (!token) return null;
  return env.DB.prepare(
    `SELECT users.id, users.email, users.display_name
       FROM sessions
       JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
}

export async function endSession(request, env) {
  const token = cookie(request, "agentkit_session");
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  }
}

export function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function deviceTokensForUser(env, userId) {
  return (await env.DB.prepare(
    `SELECT token_hash, name, scopes,
            COALESCE(expires_at, created_at + 7776000) AS expires_at,
            created_at, last_used_at
       FROM device_tokens
      WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  ).bind(userId).all()).results;
}

export async function revokeDeviceToken(env, tokenHash, userId) {
  if (!/^[a-f0-9]{64}$/.test(String(tokenHash || ""))) return false;
  const result = await env.DB.prepare(
    "UPDATE device_tokens SET revoked_at = ? WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL",
  ).bind(Math.floor(Date.now() / 1000), tokenHash, userId).run();
  return result.meta.changes === 1;
}
