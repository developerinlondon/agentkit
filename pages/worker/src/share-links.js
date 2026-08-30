import { sha256 } from "./accounts.js";

const encoder = new TextEncoder();

// The share token is derived, not stored: HMAC(SHARE_LINK_KEY, slug:generation),
// so the server can re-display the current link at any time, "enable" never has
// to rotate a circulating link just to have something to show, and a database
// dump alone reveals no share capability. Rotation = bump the generation.
async function deriveShareToken(env, slug, generation) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SHARE_LINK_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`share:${slug}:${generation}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac).slice(0, 24)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function shareCapable(env) {
  return Boolean(env.SHARE_LINK_KEY);
}

// "legacy" = a link minted before the derivable scheme: still honored via its
// stored hash, but not re-displayable. Rotating moves the page onto the scheme.
export function shareState(page) {
  if (!page) return "off";
  if (page.share_enabled) return "on";
  return page.share_token_hash ? "legacy" : "off";
}

// The current share URL, or null when sharing is off or legacy.
export async function shareUrl(env, page) {
  if (!page || !page.share_enabled || !shareCapable(env)) return null;
  const token = await deriveShareToken(env, page.slug, page.share_generation);
  return `${env.PAGES_URL}/${page.slug}?share=${token}`;
}

// Hash both sides before comparing so string comparison timing reveals nothing.
export async function shareTokenValid(env, page, presented) {
  if (!page || !presented) return false;
  if (page.share_token_hash && page.share_token_hash === await sha256(presented)) return true;
  if (!page.share_enabled || !shareCapable(env)) return false;
  const expected = await deriveShareToken(env, page.slug, page.share_generation);
  return (await sha256(presented)) === (await sha256(expected));
}

// mode: "off" disables; "rotate" bumps the generation (old link dies, legacy
// hash cleared); "enable" is idempotent — already-on pages keep their link and
// get it handed back, which is the whole point of derivable tokens.
export async function setShareLink(env, slug, mode) {
  if (mode === "off") {
    await env.DB.prepare(
      "UPDATE pages SET share_enabled = 0, share_token_hash = NULL WHERE slug = ?",
    ).bind(slug).run();
    return { enabled: false, url: null, already: false };
  }
  if (!shareCapable(env)) return { error: "share key unconfigured" };
  if (mode === "enable") {
    const turned = await env.DB.prepare(
      `UPDATE pages SET share_generation = share_generation + 1, share_enabled = 1
        WHERE slug = ? AND share_enabled = 0 AND share_token_hash IS NULL
        RETURNING slug, share_generation, share_enabled`,
    ).bind(slug).first();
    if (turned) return { enabled: true, url: await shareUrl(env, turned), already: false };
    const page = await env.DB.prepare(
      "SELECT slug, share_token_hash, share_generation, share_enabled FROM pages WHERE slug = ?",
    ).bind(slug).first();
    if (!page) return { error: "not found" };
    if (page.share_enabled) return { enabled: true, url: await shareUrl(env, page), already: true };
    return { enabled: true, url: null, already: true, legacy: true };
  }
  const rotated = await env.DB.prepare(
    `UPDATE pages SET share_generation = share_generation + 1, share_enabled = 1,
        share_token_hash = NULL WHERE slug = ? RETURNING slug, share_generation, share_enabled`,
  ).bind(slug).first();
  if (!rotated) return { error: "not found" };
  return { enabled: true, url: await shareUrl(env, rotated), already: false };
}
