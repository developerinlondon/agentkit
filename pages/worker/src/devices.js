import { randomToken, sessionUser, sha256 } from "./accounts.js";
import { escapeHtml, UI_HEADERS } from "./ui.js";

const DEVICE_TTL_SECONDS = 600;
const DEFAULT_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const POLL_INTERVAL_SECONDS = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ALLOWED_SCOPES = ["pages:write", "pages:delete", "pages:share"];

function requestedScopes(value) {
  if (value === undefined || value === null) return ALLOWED_SCOPES;
  const requested = Array.isArray(value) ? value.map(String) : String(value).split(/\s+/);
  const unique = [...new Set(requested.filter(Boolean))];
  if (unique.length === 0 || unique.some((scope) => !ALLOWED_SCOPES.includes(scope))) return null;
  return ALLOWED_SCOPES.filter((scope) => unique.includes(scope));
}

function tokenTtl(env) {
  const configured = Number(env.DEVICE_TOKEN_TTL_SECONDS || DEFAULT_TOKEN_TTL_SECONDS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_TOKEN_TTL_SECONDS;
}

function userCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function startDevice(env, deviceName, requested) {
  const scopes = requestedScopes(requested);
  if (!scopes) return null;
  const name = String(deviceName || "AgentKit device").trim().slice(0, 80);
  const deviceCode = randomToken();
  const code = userCode();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "DELETE FROM device_authorizations WHERE expires_at <= ? OR status = 'consumed'",
  ).bind(now).run();
  await env.DB.prepare(
    `INSERT INTO device_authorizations
       (device_hash, user_code_hash, device_name, status, expires_at, interval_seconds, scopes)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
  ).bind(
    await sha256(deviceCode),
    await sha256(code),
    name || "AgentKit device",
    now + DEVICE_TTL_SECONDS,
    POLL_INTERVAL_SECONDS,
    scopes.join(" "),
  ).run();
  const verificationUri = `${env.ACCOUNT_URL}/device`;
  return {
    device_code: deviceCode,
    user_code: code,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(code)}`,
    expires_in: DEVICE_TTL_SECONDS,
    interval: POLL_INTERVAL_SECONDS,
  };
}

export async function approveDevice(env, userCodeValue, userId) {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE device_authorizations SET status = 'approved', user_id = ?
      WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?`,
  ).bind(userId, await sha256(String(userCodeValue || "").toUpperCase()), now).run();
  return result.meta.changes === 1;
}

function deviceError(error, status = 400) {
  return Response.json({ error }, { status });
}

export async function pollDevice(env, deviceCode) {
  const deviceHash = await sha256(String(deviceCode || ""));
  const row = await env.DB.prepare(
    `SELECT status, expires_at, interval_seconds, last_polled_at
       FROM device_authorizations WHERE device_hash = ?`,
  ).bind(deviceHash).first();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.status === "consumed" || row.expires_at <= now) return deviceError("expired_token");
  if (row.last_polled_at && now - row.last_polled_at < row.interval_seconds) {
    return deviceError("slow_down", 429);
  }
  await env.DB.prepare("UPDATE device_authorizations SET last_polled_at = ? WHERE device_hash = ?")
    .bind(now, deviceHash).run();
  if (row.status === "pending") return deviceError("authorization_pending");
  const approved = await env.DB.prepare(
    `UPDATE device_authorizations SET status = 'consumed'
      WHERE device_hash = ? AND status = 'approved'
      RETURNING user_id, device_name, scopes`,
  ).bind(deviceHash).first();
  if (!approved) return deviceError("expired_token");
  const token = randomToken();
  const ttl = tokenTtl(env);
  await env.DB.prepare(
    `INSERT INTO device_tokens (token_hash, user_id, name, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    await sha256(token),
    approved.user_id,
    approved.device_name,
    approved.scopes,
    now + ttl,
    now,
  ).run();
  return Response.json({
    access_token: token,
    token_type: "Bearer",
    scope: approved.scopes,
    expires_in: ttl,
  });
}

export async function devicePage(request, env) {
  const user = await sessionUser(request, env);
  if (!user) {
    const url = new URL(request.url);
    return new Response(null, {
      status: 302,
      headers: { location: `/login?return_to=${encodeURIComponent(url.pathname + url.search)}` },
    });
  }
  const code = escapeHtml(new URL(request.url).searchParams.get("user_code") || "");
  return new Response(`<!doctype html><meta charset="utf-8"><title>Connect AgentKit</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:1rem"><h1>Connect AgentKit</h1>
<p>Approve a device for <strong>${escapeHtml(user.email)}</strong>.</p><form method="post" action="/api/device/approve">
<label>Code <input name="user_code" value="${code}" pattern="[A-Z2-9]{4}-[A-Z2-9]{4}" required></label>
<button>Approve device</button></form></body>`, { headers: UI_HEADERS });
}
