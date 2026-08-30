import {
  consumeDeviceWrite,
  cookieValue,
  deviceCredential,
  endSession,
  revokeDeviceToken,
  sessionUser,
  sha256,
} from "./accounts.js";
import {
  claimPage,
  deletePageRecord,
  inviteEmail,
  issuePageAccess,
  ownerByManage,
  ownerPage,
  pageRecord,
  pageReadGrant,
  removeInvite,
} from "./pages-acl.js";
import { bareShared, setShareLink, shareState, shareUrl } from "./share-links.js";
import { dashboard } from "./dashboard.js";
import { approveDevice, devicePage, pollDevice, startDevice } from "./devices.js";
import { completeLogin, startLogin } from "./oidc.js";
import { escapeHtml, UI_HEADERS } from "./ui.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){0,3}$/;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

// Slugs the site deploy flow may write, gated by SITE_TOKEN instead of
// PUBLISH_TOKEN so a leaked page-publish token cannot deface the site. Sub-page
// writes address `_site/<path>`; the two keyspaces cannot cross, because
// SLUG_RE's alphabet has no leading underscore for a PUBLISH_TOKEN slug to
// reach `_site/*` with, and every site key is rooted at `_site/`.
const SITE_SLUGS = { "_site": "_site/index.html", "_pages-index": "_site/pages-index.html" };
const SITE_PREFIX = "_site/";

// A generated docs site addresses files, not slugs: hashed bundles under
// `_astro/`, dotted filenames, Pagefind's `.pf_*` shards. SLUG_RE admits none
// of those, so asset paths get their own alphabet.
// A segment must open on an alnum or underscore, which is what keeps `..` out:
// the traversal segment cannot match, so no path climbs out of `_site/`.
const ASSET_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._-]{0,127}";
const ASSET_RE = new RegExp(`^${ASSET_SEGMENT}(\\/${ASSET_SEGMENT}){0,7}$`);
const ASSET_EXT_RE = /\.([A-Za-z0-9_]+)$/;
const DOCS_PREFIX = "docs/";

// Generated page paths carry a version segment such as `0.4`, so the site's
// page alphabet admits dots and nests deeper than a published-page slug.
const SITE_PAGE_SEGMENT = "[a-z0-9][a-z0-9.-]{0,63}";
const SITE_PAGE_RE = new RegExp(`^${SITE_PAGE_SEGMENT}(\\/${SITE_PAGE_SEGMENT}){0,7}$`);

const EXT_TYPES = {
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  pagefind: "application/octet-stream",
  pf_filter: "application/octet-stream",
  pf_fragment: "application/octet-stream",
  pf_index: "application/octet-stream",
  pf_meta: "application/octet-stream",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
};
const DEFAULT_ASSET_TYPE = "application/octet-stream";

// Astro content-addresses everything under `_astro/`, so a changed file is a
// changed name and a year-long immutable cache can never serve a stale one. The
// rest is named, not hashed, so it revalidates. Documents carry no cache header
// at all: a deploy has to be visible the moment it lands to be verifiable.
const IMMUTABLE_PREFIX = "docs/_astro/";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE = "public, max-age=300";

const BASE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
};
// Private and legacy page responses both stay out of crawler indexes. Access
// control happens before this response is built, not through an unguessable URL.
// no-store matters now that share URLs are stable: a cached copy in any
// URL-keyed intermediary would outlive "turn share link off".
const PAGE_HEADERS = {
  ...BASE_HEADERS,
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "private, no-store",
};

// Pagefind fetches index shards, spawns a worker and compiles WebAssembly from
// bytes, so search cannot run under the marketing pages' `default-src 'none'`.
// Every relaxation is `'self'`, and this policy reaches `/docs/*` only.
const DOCS_HEADERS = {
  ...BASE_HEADERS,
  "content-security-policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
};

function html(status, body, headers = BASE_HEADERS) {
  return new Response(body, { status, headers });
}

const NOT_FOUND = `<!doctype html><meta charset="utf-8"><title>Not found</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh">
<div style="text-align:center"><h1 style="letter-spacing:-0.02em">404</h1>
<p>No page lives at this address.</p></div>`;

async function servePage(env, key, headers) {
  const obj = await env.PAGES.get(key);
  if (!obj) return html(404, NOT_FOUND, headers);
  return html(200, obj.body, headers);
}

// A *known* extension, not merely a dot: the version segment in `docs/0.4` must
// keep resolving as a page rather than being looked up as a file.
function assetExt(path) {
  const match = ASSET_EXT_RE.exec(path);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  return Object.hasOwn(EXT_TYPES, ext) ? ext : null;
}

function contentTypeFor(path) {
  const ext = assetExt(path);
  return ext ? EXT_TYPES[ext] : DEFAULT_ASSET_TYPE;
}

// Every relaxation below — file keys, dotted segments, deeper nesting, the
// looser CSP — is confined to this subtree. Outside it the apex still answers
// only `<slug>/index.html` under `default-src 'none'`, so nothing here can
// widen how the hand-built marketing pages are addressed or served.
function isDocsPath(path) {
  return path === DOCS_PREFIX.slice(0, -1) || path.startsWith(DOCS_PREFIX);
}

function docsAssetKey(path) {
  if (!isDocsPath(path) || !ASSET_RE.test(path) || !assetExt(path)) return null;
  return `${SITE_PREFIX}${path}`;
}

async function serveAsset(env, key, path) {
  const obj = await env.PAGES.get(key);
  if (!obj) return new Response("not found\n", { status: 404 });
  const type = contentTypeFor(path);
  if (type === EXT_TYPES.html) {
    return html(200, obj.body, DOCS_HEADERS);
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "cache-control": path.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
    },
  });
}

// null when the slug is not site-space at all. An empty string keeps a
// malformed sub-path inside site-space, so it is still SITE_TOKEN that must
// authenticate before the 400 tells anyone the path was rejected.
function siteKey(slug) {
  if (Object.hasOwn(SITE_SLUGS, slug)) return SITE_SLUGS[slug];
  if (!slug.startsWith(SITE_PREFIX)) return null;
  const path = slug.slice(SITE_PREFIX.length);
  return SLUG_RE.test(path) ? `_site/${path}/index.html` : "";
}

// Shared write-path gate: site slugs need SITE_TOKEN; account pages need a
// live device credential, the operation's scope, and rate-limit capacity.
function bearerToken(request) {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
}

async function authorizeWrite(request, env, slug) {
  const token = bearerToken(request);
  const site = siteKey(slug);
  const isSite = site !== null;
  if (!isSite && env.ACCOUNT_MODE === "required" && !env.DB) {
    return new Response("account storage unavailable\n", { status: 503 });
  }
  if (!isSite && (env.ACCOUNT_MODE === "required" || env.DB)) {
    if (!SLUG_RE.test(slug)) return new Response("invalid slug\n", { status: 400 });
    const credential = await deviceCredential(env, token);
    if (!credential) return new Response("unauthorized\n", { status: 401 });
    const requiredScope = request.method === "DELETE" ? "pages:delete" : "pages:write";
    if (!credential.scopes.includes(requiredScope)) {
      return new Response(`insufficient scope: ${requiredScope}\n`, { status: 403 });
    }
    const rate = await consumeDeviceWrite(env, credential.tokenHash);
    if (!rate.allowed) {
      return new Response("device write rate exceeded\n", {
        status: 429,
        headers: { "retry-after": String(rate.retryAfter) },
      });
    }
    return { isSite: false, key: `pages/${slug}/index.html`, user: credential.user };
  }
  const expected = isSite ? env.SITE_TOKEN : env.PUBLISH_TOKEN;
  if (!expected || token !== expected) {
    return new Response("unauthorized\n", { status: 401 });
  }
  if (isSite ? site === "" : !SLUG_RE.test(slug)) {
    return new Response("invalid slug\n", { status: 400 });
  }
  return { isSite, key: isSite ? site : `pages/${slug}/index.html` };
}

function publishedUrl(env, slug, isSite) {
  if (!isSite) return `${env.PAGES_URL || "https://pages.agentkit.sbs"}/${slug}`;
  if (slug === "_pages-index") return "https://pages.agentkit.sbs/";
  if (slug === "_site") return "https://agentkit.sbs/";
  const path = slug.slice(SITE_PREFIX.length);
  // The docs subtree is written under `_site/docs/` but served from its own
  // host, so the URL reported back has to be the one that actually answers.
  if (isDocsPath(path)) {
    return `https://docs.agentkit.sbs/${path.slice(DOCS_PREFIX.length)}`.replace(/\/$/, "");
  }
  return `https://agentkit.sbs/${path}`;
}

async function handlePublish(request, env, slug) {
  const gate = await authorizeWrite(request, env, slug);
  if (gate instanceof Response) return gate;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_PAGE_BYTES) {
    return new Response("page must be 1 byte to 5 MB\n", { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_PAGE_BYTES) {
    return new Response("page must be 1 byte to 5 MB\n", { status: 413 });
  }
  if (gate.user) {
    const claim = await claimPage(env, slug, gate.user.id, requestedTitle(request));
    if (claim === "forbidden") return new Response("forbidden\n", { status: 403 });
    if (claim === "quota") return new Response("page quota exceeded\n", { status: 429 });
  }
  await env.PAGES.put(gate.key, body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  return Response.json({ ok: true, slug, url: publishedUrl(env, slug, gate.isSite) });
}

async function handleAssetWrite(request, env, path) {
  if (!env.SITE_TOKEN || bearerToken(request) !== env.SITE_TOKEN) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const key = docsAssetKey(path);
  if (!key) return new Response("invalid path\n", { status: 400 });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_PAGE_BYTES) {
    return new Response("asset must be 1 byte to 5 MB\n", { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_PAGE_BYTES) {
    return new Response("asset must be 1 byte to 5 MB\n", { status: 413 });
  }
  await env.PAGES.put(key, body, { httpMetadata: { contentType: contentTypeFor(path) } });
  // Docs assets are written under `docs/` but answered by the docs host.
  const served = isDocsPath(path)
    ? `https://docs.agentkit.sbs/${path.slice(DOCS_PREFIX.length)}`
    : `https://agentkit.sbs/${path}`;
  return Response.json({ ok: true, path, url: served });
}

// The deploy can only prune what it can enumerate. Scoped to the docs subtree and
// SITE_TOKEN, same as the write path: a caller that cannot write cannot list.
async function handleAssetList(request, env, rawPrefix) {
  if (!env.SITE_TOKEN || bearerToken(request) !== env.SITE_TOKEN) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const bare = rawPrefix.replace(/\/+$/, "");
  if (!isDocsPath(bare) || !ASSET_RE.test(bare)) {
    return new Response("invalid prefix\n", { status: 400 });
  }
  // Restored explicitly: the router strips the trailing slash, and a prefix of
  // `docs` would also match a sibling keyspace such as `docsy/`.
  const prefix = `${bare}/`;
  const keys = [];
  let cursor;
  do {
    const page = await env.PAGES.list({ prefix: `${SITE_PREFIX}${prefix}`, cursor });
    for (const object of page.objects) keys.push(object.key.slice(SITE_PREFIX.length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return Response.json({ ok: true, prefix, keys: keys.sort() });
}

async function handleAssetDelete(request, env, path) {
  if (!env.SITE_TOKEN || bearerToken(request) !== env.SITE_TOKEN) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const key = docsAssetKey(path);
  if (!key) return new Response("invalid path\n", { status: 400 });
  if (!(await env.PAGES.head(key))) return new Response("not found\n", { status: 404 });
  await env.PAGES.delete(key);
  return Response.json({ ok: true, deleted: path });
}

async function handleDelete(request, env, slug) {
  const gate = await authorizeWrite(request, env, slug);
  if (gate instanceof Response) return gate;
  if (gate.user) {
    const page = await pageRecord(env, slug);
    if (!page) return new Response("not found\n", { status: 404 });
    if (page.owner_id !== gate.user.id) return new Response("forbidden\n", { status: 403 });
  }
  const existing = await env.PAGES.head(gate.key);
  if (!existing) return new Response("not found\n", { status: 404 });
  await env.PAGES.delete(gate.key);
  if (gate.user) await deletePageRecord(env, slug, gate.user.id);
  return Response.json({ ok: true, deleted: slug });
}

function sameOrigin(request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}

async function requestBody(request) {
  if (request.headers.get("content-type")?.startsWith("application/json")) return request.json();
  return Object.fromEntries(await request.formData());
}

// A device holding `pages:share` may flip the link over the API; a browser
// session stays same-origin. The scope is separate from `pages:write` because
// enabling a share link changes who can READ the page, which a stolen publish
// token must not be able to do.
async function shareByDevice(request, env, slug, bearer) {
  const credential = await deviceCredential(env, bearer);
  if (!credential) return new Response("unauthorized\n", { status: 401 });
  if (!credential.scopes.includes("pages:share")) {
    return new Response("insufficient scope: pages:share\n", { status: 403 });
  }
  const page = await pageRecord(env, slug);
  if (!page || page.owner_id !== credential.user.id) {
    return new Response("not found\n", { status: 404 });
  }
  return rateLimitedShareChange(request, env, slug, credential.tokenHash);
}

function shareChangeResponse(result) {
  if (result.error === "not found") return new Response("not found\n", { status: 404 });
  if (result.error) return new Response(`share links unavailable: ${result.error}\n`, { status: 503 });
  return Response.json({ ok: true, ...result });
}

async function rateLimitedShareChange(request, env, slug, limiterKey, limiterTable) {
  const rate = await consumeDeviceWrite(env, limiterKey, limiterTable);
  if (!rate.allowed) {
    return new Response("share write rate exceeded\n", {
      status: 429,
      headers: { "retry-after": String(rate.retryAfter) },
    });
  }
  const body = await requestBody(request);
  const enabled = body.enabled === true || body.enabled === "true";
  return shareChangeResponse(await setShareLink(env, slug, enabled ? "enable" : "off"));
}

async function handleShare(request, env, slug) {
  const bearer = bearerToken(request);
  if (bearer) return shareByDevice(request, env, slug, bearer);
  if (!sameOrigin(request)) return new Response("forbidden\n", { status: 403 });
  if (!(await ownerPage(request, env, slug))) return new Response("not found\n", { status: 404 });
  const body = await requestBody(request);
  const enabled = body.enabled === true || body.enabled === "true";
  const result = await setShareLink(env, slug, enabled ? "enable" : "off");
  if (!result.error && !request.headers.get("content-type")?.startsWith("application/json")) {
    // The dashboard shows the derived link persistently, so the form flow just
    // returns to it — no one-shot reveal cookie needed any more.
    return new Response(null, { status: 303, headers: { location: "/dashboard" } });
  }
  return shareChangeResponse(result);
}

async function handleInvite(request, env, slug) {
  if (!sameOrigin(request)) return new Response("forbidden\n", { status: 403 });
  if (!(await ownerPage(request, env, slug))) return new Response("not found\n", { status: 404 });
  const body = await requestBody(request);
  if (!(await inviteEmail(env, slug, String(body.email || "")))) {
    return new Response("invalid email\n", { status: 400 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return new Response(null, { status: 303, headers: { location: "/dashboard" } });
  }
  return Response.json({ ok: true, email: String(body.email).trim().toLowerCase() });
}

async function handleInviteRemove(request, env, slug) {
  if (!sameOrigin(request)) return new Response("forbidden\n", { status: 403 });
  if (!(await ownerPage(request, env, slug))) return new Response("not found\n", { status: 404 });
  const body = await requestBody(request);
  await removeInvite(env, slug, body.email);
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return new Response(null, { status: 303, headers: { location: "/dashboard" } });
  }
  return Response.json({ ok: true });
}

async function handleDeviceApprove(request, env) {
  if (!sameOrigin(request)) return new Response("forbidden\n", { status: 403 });
  const user = await sessionUser(request, env);
  if (!user) return new Response("unauthorized\n", { status: 401 });
  const body = await requestBody(request);
  if (!(await approveDevice(env, body.user_code, user.id))) {
    return new Response("invalid or expired code\n", { status: 400 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return html(200, "<!doctype html><meta charset=utf-8><h1>Device connected</h1><p>You can close this window.</p>");
  }
  return Response.json({ ok: true });
}

async function handleDeviceRevoke(request, env, tokenHash) {
  if (!sameOrigin(request)) return new Response("forbidden\n", { status: 403 });
  const user = await sessionUser(request, env);
  if (!user) return new Response("unauthorized\n", { status: 401 });
  if (!(await revokeDeviceToken(env, tokenHash, user.id))) {
    return new Response("not found\n", { status: 404 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return new Response(null, { status: 303, headers: { location: "/dashboard" } });
  }
  return Response.json({ ok: true });
}

function configuredHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

// A share token is the one query parameter allowed to round-trip through
// /access: it lets an owner's browser upgrade a share-link visit to the shell,
// and lets anyone else fall back to the plain shared page instead of a login
// wall. Everything else in the query is still rejected.
function requestedPageTarget(request, env) {
  const raw = new URL(request.url).searchParams.get("return_to");
  if (!raw) return null;
  try {
    const target = new URL(raw);
    const pagesOrigin = new URL(env.PAGES_URL).origin;
    const slug = target.pathname.replace(/^\/+|\/+$/g, "");
    const extraneous = [...target.searchParams.keys()].some((key) => key !== "share");
    const share = target.searchParams.get("share");
    if (
      target.origin !== pagesOrigin || extraneous || target.hash || !SLUG_RE.test(slug)
      || (share !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(share))
    ) {
      return null;
    }
    return { target, slug, share };
  } catch {
    return null;
  }
}

const PRIVATE_PAGE = `<!doctype html><meta charset="utf-8"><title>Private page</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh">
<div style="text-align:center;max-width:34rem;padding:0 1rem"><h1 style="letter-spacing:-0.02em">This page is private</h1>
<p>Your account doesn't have access to it. If someone sent you this link, it was
probably their personal, time-limited pass — those expire. Ask them for a share
link instead (the Share menu on the page hands one out that works indefinitely).</p></div>`;

// The plain=1 marker tells the pages host not to bounce this visit back here,
// which would otherwise loop for a browser holding an owner cookie.
function backToSharedPage(requested) {
  requested.target.searchParams.set("plain", "1");
  return new Response(null, { status: 302, headers: { location: requested.target.toString() } });
}

async function handlePageAccess(request, env) {
  const requested = requestedPageTarget(request, env);
  if (!requested) return new Response("invalid page target\n", { status: 400 });
  // A page with no record predates accounts and is world-readable — telling a
  // visitor it is private would be false. Send them straight to it.
  const record = await pageRecord(env, requested.slug);
  if (!record) {
    requested.target.search = "";
    return new Response(null, { status: 302, headers: { location: requested.target.toString() } });
  }
  // A bare-shared page is readable without any grant, so nobody who cannot
  // sign in (or is not invited) should ever hit a wall on the way to it.
  const openToAll = requested.share || bareShared(record);
  const user = await sessionUser(request, env);
  if (!user) {
    if (openToAll) return backToSharedPage(requested);
    const current = new URL(request.url);
    const returnTo = `${current.pathname}${current.search}`;
    return new Response(null, {
      status: 302,
      headers: { location: `/login?return_to=${encodeURIComponent(returnTo)}` },
    });
  }
  const issued = await issuePageAccess(env, requested.slug, user);
  if (!issued) {
    if (openToAll) return backToSharedPage(requested);
    return html(403, PRIVATE_PAGE);
  }
  requested.target.searchParams.delete("share");
  requested.target.searchParams.set("access", issued.access);
  if (issued.manage) requested.target.searchParams.set("manage", issued.manage);
  return new Response(null, { status: 302, headers: { location: requested.target.toString() } });
}

function requestedTitle(request) {
  const encoded = request.headers.get("x-page-title");
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded).trim().slice(0, 200) || null;
  } catch {
    return null;
  }
}

// `servesDocs` separates the two hosts that reach this handler: the docs host
// serves the `docs/` subtree, the marketing host no longer does. Writes are
// unaffected — an `api/site/...` path is not a docs path.
async function handleSiteRequest(request, env, path, servesDocs = false) {
  if (
    (request.method === "PUT" || request.method === "DELETE")
    && path.startsWith("api/pages/")
  ) {
    const slug = path.slice("api/pages/".length);
    if (siteKey(slug) === null) return html(404, NOT_FOUND);
    return request.method === "PUT"
      ? handlePublish(request, env, slug)
      : handleDelete(request, env, slug);
  }
  if (request.method === "GET" && path.startsWith("api/site-list/")) {
    return handleAssetList(request, env, path.slice("api/site-list/".length));
  }
  if (request.method === "PUT" && path.startsWith("api/site/")) {
    return handleAssetWrite(request, env, path.slice("api/site/".length));
  }
  if (request.method === "DELETE" && path.startsWith("api/site/")) {
    return handleAssetDelete(request, env, path.slice("api/site/".length));
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed\n", { status: 405 });
  }
  if (path === "") return servePage(env, "_site/index.html", BASE_HEADERS);
  if (isDocsPath(path)) {
    if (!servesDocs) return html(404, NOT_FOUND);
    const assetKey = docsAssetKey(path);
    if (assetKey) return serveAsset(env, assetKey, path);
    if (!SITE_PAGE_RE.test(path)) return html(404, NOT_FOUND, DOCS_HEADERS);
    return servePage(env, `_site/${path}/index.html`, DOCS_HEADERS);
  }
  if (!SLUG_RE.test(path)) return html(404, NOT_FOUND);
  return servePage(env, `_site/${path}/index.html`, BASE_HEADERS);
}

async function handleAccountRequest(request, env, path) {
  if (request.method === "PUT" && path.startsWith("api/pages/")) {
    return handlePublish(request, env, path.slice("api/pages/".length));
  }
  if (request.method === "DELETE" && path.startsWith("api/pages/")) {
    return handleDelete(request, env, path.slice("api/pages/".length));
  }
  const shareMatch = /^api\/pages\/(.+)\/share$/.exec(path);
  if (request.method === "POST" && shareMatch) return handleShare(request, env, shareMatch[1]);
  const inviteRemoveMatch = /^api\/pages\/(.+)\/invites\/remove$/.exec(path);
  if (request.method === "POST" && inviteRemoveMatch) {
    return handleInviteRemove(request, env, inviteRemoveMatch[1]);
  }
  const inviteMatch = /^api\/pages\/(.+)\/invites$/.exec(path);
  if (request.method === "POST" && inviteMatch) return handleInvite(request, env, inviteMatch[1]);
  if (request.method === "POST" && path === "api/device/authorize") {
    const body = await requestBody(request);
    const started = await startDevice(env, body.device_name, body.scopes);
    return started ? Response.json(started) : Response.json({ error: "invalid_scope" }, { status: 400 });
  }
  if (request.method === "POST" && path === "api/device/approve") {
    return handleDeviceApprove(request, env);
  }
  if (request.method === "POST" && path === "api/device/token") {
    const body = await requestBody(request);
    return pollDevice(env, body.device_code);
  }
  const deviceRevokeMatch = /^api\/devices\/([a-f0-9]{64})\/revoke$/.exec(path);
  if (request.method === "POST" && deviceRevokeMatch) {
    return handleDeviceRevoke(request, env, deviceRevokeMatch[1]);
  }
  if (request.method === "GET" && path === "device") return devicePage(request, env);
  if (request.method === "GET" && path === "login") return startLogin(request, env);
  if (request.method === "GET" && path === "auth/callback") return completeLogin(request, env);
  if (request.method === "GET" && path === "access") return handlePageAccess(request, env);
  if (request.method === "POST" && path === "logout") {
    if (!sameOrigin(request)) return new Response("forbidden\n", { status: 403 });
    await endSession(request, env);
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": "agentkit_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      },
    });
  }
  if (request.method === "GET" && (path === "" || path === "dashboard")) {
    const user = await sessionUser(request, env);
    if (!user) {
      return new Response(null, {
        status: 302,
        headers: { location: "/login?return_to=%2Fdashboard" },
      });
    }
    return html(200, await dashboard(env, user), UI_HEADERS);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed\n", { status: 405 });
  }
  return html(404, NOT_FOUND, UI_HEADERS);
}

// Slugs whose owner shell this browser has held — a hint deciding whether a
// share-link visit is worth bouncing through /access, never a credential.
// Per-slug so someone else's share link never detours through the account
// origin, which would put their token in its logs for nothing.
const OWNER_HINT_COOKIE = "agentkit_owner";
const OWNER_HINT_MAX_SLUGS = 24;

function ownerHintSlugs(request) {
  return (cookieValue(request, OWNER_HINT_COOKIE) || "").split("|")
    .filter((known) => SLUG_RE.test(known));
}

function ownerHintCookie(request, slug) {
  const slugs = [slug, ...ownerHintSlugs(request).filter((known) => known !== slug)]
    .slice(0, OWNER_HINT_MAX_SLUGS);
  return `${OWNER_HINT_COOKIE}=${slugs.join("|")}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=15552000`;
}

function redirectToAccess(env, request, share) {
  const target = new URL(request.url);
  target.search = "";
  if (share) target.searchParams.set("share", share);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${env.ACCOUNT_URL}/access?return_to=${encodeURIComponent(target.toString())}`,
    },
  });
}

async function handlePagesRequest(request, env, path) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return html(404, NOT_FOUND, PAGE_HEADERS);
  }
  if (path === "") return servePage(env, "_site/pages-index.html", PAGE_HEADERS);
  if (!SLUG_RE.test(path)) return html(404, NOT_FOUND, PAGE_HEADERS);
  const page = await pageRecord(env, path);
  const grant = await pageReadGrant(request, env, page);
  const url = new URL(request.url);
  if (!grant.allowed) return redirectToAccess(env, request, null);
  if (url.searchParams.get("embed") === "1") {
    return servePage(env, `pages/${path}/index.html`, EMBED_HEADERS);
  }
  if (
    grant.viaShare
    && url.searchParams.get("plain") !== "1"
    && ownerHintSlugs(request).includes(path)
  ) {
    return redirectToAccess(env, request, url.searchParams.get("share"));
  }
  const manage = url.searchParams.get("manage");
  if (grant.owner && manage) {
    return html(200, await shellDocument(env, path, page), {
      ...SHELL_HEADERS,
      "set-cookie": ownerHintCookie(request, path),
    });
  }
  return servePage(env, `pages/${path}/index.html`, PAGE_HEADERS);
}

// The shell is worker-authored, so it alone may fetch same-origin and frame
// the content. The content keeps the sealed page policy plus permission to be
// framed by this origin; it still cannot fetch, submit, or read the shell.
const SHELL_HEADERS = {
  ...PAGE_HEADERS,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
};
const EMBED_HEADERS = {
  ...PAGE_HEADERS,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'",
};

// The owner chrome is a bar with its own strip of the viewport — the content
// iframe starts below it, so nothing here can ever cover a page's own controls
// (the floating mid-edge tab this replaces could). The bar also keeps the
// address bar honest: the durable share URL when sharing is on, the clean page
// URL when it is off — never the personal, expiring access pass.
async function shellDocument(env, slug, page) {
  const title = escapeHtml(page.title || slug);
  const dashboard = `${env.ACCOUNT_URL}/dashboard#page-${slug}`;
  const link = await shareUrl(env, page);
  const state = shareState(env, page);
  const labels = {
    on: "Shared by link",
    legacy: "Shared by link",
    off: "Private",
    unavailable: "Sharing unavailable",
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
[hidden]{display:none!important}
html,body{margin:0;height:100%;background:#131417}
#content{position:fixed;top:42px;left:0;right:0;bottom:0;border:0;width:100%;height:calc(100% - 42px)}
#aks-bar{position:fixed;top:0;left:0;right:0;height:42px;z-index:10;display:flex;align-items:center;gap:10px;padding:0 12px;box-sizing:border-box;background:#1b1d22;color:#eee;border-bottom:1px solid #2a2d34;font:13px/1.4 system-ui,sans-serif}
#aks-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#aks-state{flex:none;font:600 11px/1 system-ui,sans-serif;letter-spacing:.04em;padding:5px 9px;border-radius:99px;border:1px solid #3a3f47;color:#a9b2bf}
#aks-state.on{border-color:#79a8e7;color:#a8c8f0}
#aks-share{flex:none;margin-left:auto}
#aks-menu{position:fixed;top:48px;right:8px;z-index:11;width:280px;background:#1b1d22;color:#eee;border:1px solid #2a2d34;border-radius:10px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.45);font:13px/1.4 system-ui,sans-serif}
#aks-note{color:#a9b2bf;margin-bottom:8px}
#aks-url{font:11px/1.4 ui-monospace,monospace;word-break:break-all;background:#131417;border:1px solid #2a2d34;border-radius:6px;padding:6px;margin-bottom:8px}
#aks-err{color:#e06c75;margin-top:8px}
.aks-b{font:600 12px/1 system-ui,sans-serif;padding:8px 10px;border-radius:7px;border:1px solid #3a3f47;background:#23262d;color:#eee;cursor:pointer;display:block;width:100%;text-align:center;text-decoration:none;box-sizing:border-box}
.aks-b:hover{border-color:#79a8e7}
#aks-bar .aks-b{width:auto;padding:6px 12px}
#aks-menu .btns{display:flex;flex-direction:column;gap:6px}
</style></head><body>
<div id="aks-bar">
<span id="aks-title">${title}</span>
<span id="aks-state" class="${state === "on" || state === "legacy" ? "on" : ""}">${labels[state]}</span>
<button class="aks-b" id="aks-share">Share</button>
</div>
<div id="aks-menu" hidden>
<div id="aks-note"></div>
<div id="aks-url" hidden></div>
<div class="btns">
<button class="aks-b" id="aks-on" hidden>Turn share link on</button>
<button class="aks-b" id="aks-copy" hidden>Copy link</button>
<button class="aks-b" id="aks-rotate" hidden>Rotate link (old one dies)</button>
<button class="aks-b" id="aks-off" hidden>Turn share link off</button>
<a class="aks-b" href="${dashboard}" target="_blank" rel="noopener">Invites &amp; settings</a>
</div>
<div id="aks-err" hidden></div>
</div>
<iframe id="content" title="${title}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe>
<script>(function(){
var $=function(id){return document.getElementById(id)};
var q=new URLSearchParams(location.search);
var manage=q.get("manage");
var state=${JSON.stringify(state)};
var link=${JSON.stringify(link)};
var NOTES={
on:"Anyone with this link can view the page, until you turn it off.",
legacy:"Shared by a link made before links were recoverable, so it cannot be shown here. Rotate to get a visible link (the old one dies), or turn sharing off.",
off:"Private. Only you and invited people can open it.",
unavailable:"Share links are not configured on this deployment. Ask the operator to set the share key; nothing here is safe to toggle until then."};
$("content").src="/${slug}?embed=1&access="+encodeURIComponent(q.get("access")||"")+location.hash;
var LABELS={on:"Shared by link",legacy:"Shared by link",off:"Private",unavailable:"Sharing unavailable"};
function render(){
$("aks-state").textContent=LABELS[state];
$("aks-state").className=(state==="on"||state==="legacy")?"on":"";
$("aks-note").textContent=NOTES[state];
$("aks-url").hidden=!link;if(link)$("aks-url").textContent=link;
$("aks-copy").hidden=!link;
$("aks-on").hidden=state!=="off";
$("aks-rotate").hidden=state==="off"||state==="unavailable"||(link&&link.indexOf("?share=")<0);
$("aks-off").hidden=state==="off"||state==="unavailable";
try{history.replaceState(null,"",(state==="on"&&link?link:"/${slug}")+location.hash)}catch(e){}
}
$("aks-share").addEventListener("click",function(){$("aks-menu").hidden=!$("aks-menu").hidden});
function fail(m){$("aks-err").textContent=m;$("aks-err").hidden=false}
function act(action){$("aks-err").hidden=true;
fetch("/api/pages/${slug}/share",{method:"POST",headers:{"authorization":"Bearer "+manage,"content-type":"application/json"},body:JSON.stringify({action:action})})
.then(function(r){if(r.status===401)throw new Error("Session pass expired - reload the page");if(!r.ok)throw new Error("Share update failed ("+r.status+")");return r.json()})
.then(function(d){
state=d.enabled?(d.url?"on":"legacy"):"off";
link=d.url||null;
render()})
.catch(function(e){fail(e.message)})}
$("aks-on").addEventListener("click",function(){act("enable")});
$("aks-rotate").addEventListener("click",function(){act("rotate")});
$("aks-off").addEventListener("click",function(){act("off")});
render();
$("aks-copy").addEventListener("click",function(){
if(!link)return;
if(!navigator.clipboard){fail("Clipboard unavailable - copy the link text above by hand");return}
navigator.clipboard.writeText(link).then(function(){
$("aks-copy").textContent="Copied";
setTimeout(function(){$("aks-copy").textContent="Copy link"},1500);
}).catch(function(){fail("Copy failed - select the link text above")})});
})()</script></body></html>`;
}

const SHARE_ACTIONS = { enable: "enable", rotate: "rotate", off: "off" };

async function handleOwnerShare(request, env, slug) {
  if (!sameOrigin(request)) return new Response("forbidden\n", { status: 403 });
  if (!SLUG_RE.test(slug) || !env.DB) return new Response("not found\n", { status: 404 });
  let mode;
  try {
    mode = SHARE_ACTIONS[(await requestBody(request)).action];
  } catch {
    mode = undefined;
  }
  if (!mode) return new Response("invalid action\n", { status: 400 });
  const page = await pageRecord(env, slug);
  if (!page) return new Response("not found\n", { status: 404 });
  const bearer = bearerToken(request);
  const owner = bearer && await ownerByManage(env, slug, bearer);
  if (!owner || owner.user_id !== page.owner_id) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const rate = await consumeDeviceWrite(env, await sha256(owner.user_id), "share_write_limits");
  if (!rate.allowed) {
    return new Response("share write rate exceeded\n", {
      status: 429,
      headers: { "retry-after": String(rate.retryAfter) },
    });
  }
  return shareChangeResponse(await setShareLink(env, slug, mode));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    const path = url.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
    const siteRequest = host === "agentkit.sbs" || host === "www.agentkit.sbs";
    // The docs have their own host, serving the same `_site/docs/` keyspace the
    // marketing site serves under a path. Read-only by construction: prefixing
    // the path moves every write endpoint out of the shape that matches one.
    const docsRequest = host === "docs.agentkit.sbs";
    const accountHost = configuredHost(env.ACCOUNT_URL);
    const pagesHost = configuredHost(env.PAGES_URL) || "pages.agentkit.sbs";
    const accountRequest = accountHost !== null && host === accountHost;
    const pagesRequest = pagesHost !== null && host === pagesHost;

    if (!siteRequest && !docsRequest && env.ACCOUNT_MODE === "required") {
      if (!env.DB || accountHost === null) {
        return new Response("account storage unavailable\n", { status: 503 });
      }
      // Without the key every derived share link silently 302s to a login
      // wall while everything else looks healthy; a 503 at deploy is cheaper.
      if (!env.SHARE_LINK_KEY) {
        return new Response("share key unconfigured\n", { status: 503 });
      }
    }

    if (docsRequest) return handleSiteRequest(request, env, path === "" ? "docs" : `docs/${path}`, true);

    if (siteRequest) return handleSiteRequest(request, env, path);

    if (accountHost === null && pagesRequest) {
      if (request.method === "PUT" && path.startsWith("api/pages/")) {
        return handlePublish(request, env, path.slice("api/pages/".length));
      }
      if (request.method === "DELETE" && path.startsWith("api/pages/")) {
        return handleDelete(request, env, path.slice("api/pages/".length));
      }
    }

    if (accountRequest) return handleAccountRequest(request, env, path);

    if (!pagesRequest) return html(404, NOT_FOUND);
    const ownerShareMatch = path.match(/^api\/pages\/(.+)\/share$/);
    if (request.method === "POST" && ownerShareMatch) {
      return handleOwnerShare(request, env, ownerShareMatch[1]);
    }
    return handlePagesRequest(request, env, path);
  },
};
