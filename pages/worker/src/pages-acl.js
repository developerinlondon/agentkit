import { randomToken, sessionUser, sha256 } from "./accounts.js";

const PAGE_ACCESS_TTL_SECONDS = 10 * 60;
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
// `owner` is true only for a capability minted to the owner's own account —
// share-link bearers and legacy public reads stay indistinguishable from any
// other visitor, so nothing owner-only can leak onto their copy of the page.
export async function pageReadGrant(request, env, page) {
  if (!page || page.visibility === "public") return { allowed: true, owner: false };
  const share = new URL(request.url).searchParams.get("share");
  if (share && page.share_token_hash === await sha256(share)) return { allowed: true, owner: false };
  const access = new URL(request.url).searchParams.get("access");
  if (!access) return { allowed: false, owner: false };
  const grant = await ownerByAccess(env, page.slug, access);
  if (!grant) return { allowed: false, owner: false };
  return { allowed: true, owner: grant.user_id === page.owner_id };
}
export async function ownerByAccess(env, slug, token) {
  return env.DB.prepare(
    `SELECT user_id FROM page_access_tokens
      WHERE token_hash = ? AND page_slug = ? AND expires_at > ?`,
  ).bind(await sha256(token), slug, Math.floor(Date.now() / 1000)).first();
}

async function userCanReadPage(env, user, page) {
  if (!user || !page) return false;
  if (user.id === page.owner_id) return true;
  const invite = await env.DB.prepare(
    "SELECT 1 AS allowed FROM page_invites WHERE page_slug = ? AND email = ?",
  ).bind(page.slug, user.email.toLowerCase()).first();
  return Boolean(invite);
}
export async function issuePageAccess(env, slug, user) {
  const page = await pageRecord(env, slug);
  if (!(await userCanReadPage(env, user, page))) return null;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM page_access_tokens WHERE expires_at <= ?").bind(now).run();
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO page_access_tokens (token_hash, page_slug, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(page_slug, user_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
  ).bind(await sha256(token), slug, user.id, now + PAGE_ACCESS_TTL_SECONDS, now).run();
  return token;
}
export async function ownerPage(request, env, slug) {
  const [user, page] = await Promise.all([sessionUser(request, env), pageRecord(env, slug)]);
  if (!user || !page || page.owner_id !== user.id) return null;
  return { user, page };
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
  const normalized = String(email || "").trim().toLowerCase();
  await env.DB.prepare("DELETE FROM page_invites WHERE page_slug = ? AND email = ?")
    .bind(slug, normalized).run();
  await env.DB.prepare(
    `DELETE FROM page_access_tokens
      WHERE page_slug = ?
        AND user_id IN (SELECT id FROM users WHERE email = ?)`,
  ).bind(slug, normalized).run();
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
