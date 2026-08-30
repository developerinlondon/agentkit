import { sha256 } from "./accounts.js";

const encoder = new TextEncoder();

// The share token is derived, not stored: HMAC(SHARE_LINK_KEY, slug:generation),
// so the server can re-display the current link at any time, "enable" never has
// to rotate a circulating link just to have something to show, and a database
// dump alone reveals no share capability. Rotation = bump the generation.
let cachedSecret = null;
let cachedKey = null;

async function hmacKey(env) {
  if (cachedSecret !== env.SHARE_LINK_KEY) {
    cachedSecret = env.SHARE_LINK_KEY;
    cachedKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.SHARE_LINK_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return cachedKey;
}

async function deriveShareToken(env, slug, generation) {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env),
    encoder.encode(`share:${slug}:${generation}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac).slice(0, 24)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function shareCapable(env) {
  return Boolean(env.SHARE_LINK_KEY);
}

// "legacy" = a link minted before the derivable scheme: still honored via its
// stored hash, but not re-displayable. Rotating moves the page onto the scheme.
// "unavailable" = the page says shared but this deployment has no share key —
// a config error, which must never be presented as a data condition the owner
// could "fix" destructively.
export function shareState(env, page) {
  if (!page) return "off";
  if (page.share_enabled) return shareCapable(env) ? "on" : "unavailable";
  return page.share_token_hash ? "legacy" : "off";
}

// The current share URL, or null when sharing is off, legacy, or keyless.
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
// get it handed back, which is the whole point of derivable tokens. Anything
// else is refused: the destructive rotation must never be a fall-through.
export async function setShareLink(env, slug, mode) {
  if (mode === "off") {
    await env.DB.prepare(
      "UPDATE pages SET share_enabled = 0, share_token_hash = NULL WHERE slug = ?",
    ).bind(slug).run();
    return { enabled: false, url: null, already: false };
  }
  if (mode !== "enable" && mode !== "rotate") return { error: "invalid mode" };
  if (!shareCapable(env)) return { error: "share key unconfigured" };
  if (mode === "enable") {
    const before = await env.DB.prepare(
      "SELECT share_enabled FROM pages WHERE slug = ?",
    ).bind(slug).first();
    if (!before) return { error: "not found" };
    // One statement decides the outcome, so a concurrent off/enable can never
    // yield a state report that contradicts the row: a legacy hash freezes the
    // row, anything else ends enabled, and the generation bumps only on a real
    // off-to-on transition (re-enabling must not resurrect a revoked link).
    const row = await env.DB.prepare(
      `UPDATE pages SET
          share_generation = CASE
            WHEN share_enabled = 0 AND share_token_hash IS NULL
            THEN share_generation + 1 ELSE share_generation END,
          share_enabled = CASE WHEN share_token_hash IS NULL THEN 1 ELSE share_enabled END
        WHERE slug = ?
        RETURNING slug, share_token_hash, share_generation, share_enabled`,
    ).bind(slug).first();
    if (!row) return { error: "not found" };
    if (row.share_token_hash) return { enabled: true, url: null, already: true, legacy: true };
    return { enabled: true, url: await shareUrl(env, row), already: Boolean(before.share_enabled) };
  }
  const rotated = await env.DB.prepare(
    `UPDATE pages SET share_generation = share_generation + 1, share_enabled = 1,
        share_token_hash = NULL WHERE slug = ? RETURNING slug, share_generation, share_enabled`,
  ).bind(slug).first();
  if (!rotated) return { error: "not found" };
  return { enabled: true, url: await shareUrl(env, rotated), already: false };
}
