import { randomToken, sha256 } from "./accounts.js";

const STATE_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function safeReturnTo(value) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function configured(env) {
  return Boolean(env.DB && env.ACCOUNT_URL && env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
}

export async function startLogin(request, env) {
  if (!configured(env)) return new Response("authentication is not configured\n", { status: 503 });
  const state = randomToken();
  const verifier = randomToken(48);
  const now = Math.floor(Date.now() / 1000);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare(
    "INSERT INTO oauth_states (state_hash, verifier, return_to, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(await sha256(state), verifier, returnTo, now + STATE_TTL_SECONDS).run();
  const target = new URL(`${env.OIDC_ISSUER}/authorize`);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", env.OIDC_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${env.ACCOUNT_URL}/auth/callback`);
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("code_challenge", await pkceChallenge(verifier));
  target.searchParams.set("code_challenge_method", "S256");
  return new Response(null, { status: 302, headers: { location: target.toString() } });
}

async function exchangeCode(env, code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${env.ACCOUNT_URL}/auth/callback`,
    code_verifier: verifier,
  });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (env.OIDC_CLIENT_SECRET) {
    headers.authorization = `Basic ${btoa(`${env.OIDC_CLIENT_ID}:${env.OIDC_CLIENT_SECRET}`)}`;
  } else {
    body.set("client_id", env.OIDC_CLIENT_ID);
  }
  const oidcFetch = env.OIDC_FETCH || fetch;
  const response = await oidcFetch(`${env.OIDC_ISSUER}/token`, { method: "POST", headers, body });
  if (!response.ok) return null;
  const tokens = await response.json();
  if (!tokens.access_token) return null;
  const userinfo = await oidcFetch(`${env.OIDC_ISSUER}/userinfo`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  return userinfo.ok ? userinfo.json() : null;
}

export async function completeLogin(request, env) {
  if (!configured(env)) return new Response("authentication is not configured\n", { status: 503 });
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) return new Response("invalid callback\n", { status: 400 });
  const stateHash = await sha256(state);
  const saved = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING verifier, return_to",
  ).bind(stateHash, Math.floor(Date.now() / 1000)).first();
  if (!saved) return new Response("invalid or expired state\n", { status: 400 });
  const userinfo = await exchangeCode(env, code, saved.verifier);
  if (!userinfo?.sub || !userinfo.email || userinfo.email_verified !== true) {
    return new Response("a verified email is required\n", { status: 403 });
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name`,
  ).bind(userinfo.sub, String(userinfo.email).toLowerCase(), userinfo.name || userinfo.email, now).run();
  const session = randomToken();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(await sha256(session), userinfo.sub, now + SESSION_TTL_SECONDS, now).run();
  return new Response(null, {
    status: 302,
    headers: {
      location: saved.return_to,
      "set-cookie": `agentkit_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
    },
  });
}
