const encoder = new TextEncoder();

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deviceUser(env, token) {
  if (!env.DB || !token) return null;
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(
    `SELECT users.id, users.email, users.display_name
       FROM device_tokens
       JOIN users ON users.id = device_tokens.user_id
      WHERE device_tokens.token_hash = ? AND device_tokens.revoked_at IS NULL`,
  ).bind(tokenHash).first();
  if (!user) return null;
  await env.DB.prepare("UPDATE device_tokens SET last_used_at = ? WHERE token_hash = ?")
    .bind(Math.floor(Date.now() / 1000), tokenHash).run();
  return user;
}

export async function pageRecord(env, slug) {
  if (!env.DB) return null;
  return env.DB.prepare(
    "SELECT slug, owner_id, visibility, share_token_hash FROM pages WHERE slug = ?",
  ).bind(slug).first();
}

export async function claimPage(env, slug, userId, title) {
  const existing = await pageRecord(env, slug);
  if (existing && existing.owner_id !== userId) return "forbidden";
  const now = Math.floor(Date.now() / 1000);
  if (!existing) {
    const configured = Number(env.MAX_PAGES_PER_USER || 100);
    const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 100;
    const result = await env.DB.prepare(
      `INSERT INTO pages (slug, owner_id, title, visibility, created_at, updated_at)
       SELECT ?, ?, ?, 'private', ?, ?
        WHERE (SELECT COUNT(*) FROM pages WHERE owner_id = ?) < ?`,
    ).bind(slug, userId, title || null, now, now, userId, limit).run();
    return result.meta.changes === 1 ? "claimed" : "quota";
  }
  await env.DB.prepare(
    "UPDATE pages SET title = ?, updated_at = ? WHERE slug = ?",
  ).bind(title || null, now, slug).run();
  return "claimed";
}

export async function deletePageRecord(env, slug, userId) {
  const existing = await pageRecord(env, slug);
  if (!existing) return "missing";
  if (existing.owner_id !== userId) return "forbidden";
  await env.DB.prepare("DELETE FROM pages WHERE slug = ?").bind(slug).run();
  return "deleted";
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

export async function canReadPage(request, env, page) {
  if (!page || page.visibility === "public") return true;
  const share = new URL(request.url).searchParams.get("share");
  if (share && page.share_token_hash === await sha256(share)) return true;
  const user = await sessionUser(request, env);
  if (!user) return false;
  if (user.id === page.owner_id) return true;
  const invite = await env.DB.prepare(
    "SELECT 1 AS allowed FROM page_invites WHERE page_slug = ? AND email = ?",
  ).bind(page.slug, user.email.toLowerCase()).first();
  return Boolean(invite);
}

export async function ownerPage(request, env, slug) {
  const [user, page] = await Promise.all([sessionUser(request, env), pageRecord(env, slug)]);
  if (!user || !page || page.owner_id !== user.id) return null;
  return { user, page };
}

export function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function setShareLink(env, slug, enabled) {
  if (!enabled) {
    await env.DB.prepare("UPDATE pages SET share_token_hash = NULL WHERE slug = ?").bind(slug).run();
    return null;
  }
  const token = randomToken();
  await env.DB.prepare("UPDATE pages SET share_token_hash = ? WHERE slug = ?")
    .bind(await sha256(token), slug).run();
  return token;
}

export async function inviteEmail(env, slug, email) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return false;
  await env.DB.prepare(
    "INSERT INTO page_invites (page_slug, email, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).bind(slug, normalized, Math.floor(Date.now() / 1000)).run();
  return true;
}

export async function removeInvite(env, slug, email) {
  await env.DB.prepare("DELETE FROM page_invites WHERE page_slug = ? AND email = ?")
    .bind(slug, String(email || "").trim().toLowerCase()).run();
}

export async function pagesForUser(env, userId) {
  return (await env.DB.prepare(
    `SELECT slug, title, visibility, share_token_hash, created_at, updated_at
       FROM pages WHERE owner_id = ? ORDER BY updated_at DESC`,
  ).bind(userId).all()).results;
}

export async function invitesForUserPages(env, userId) {
  return (await env.DB.prepare(
    `SELECT page_invites.page_slug, page_invites.email
       FROM page_invites
       JOIN pages ON pages.slug = page_invites.page_slug
      WHERE pages.owner_id = ? ORDER BY page_invites.email`,
  ).bind(userId).all()).results;
}

export async function deviceTokensForUser(env, userId) {
  return (await env.DB.prepare(
    `SELECT token_hash, name, created_at, last_used_at
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
