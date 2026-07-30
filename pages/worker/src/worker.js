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
// Published pages are public-by-slug until the accounts phase: keep crawlers
// out so an unlinked slug stays unlisted.
const PAGE_HEADERS = { ...BASE_HEADERS, "x-robots-tag": "noindex, nofollow" };

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

// Shared write-path gate: bearer auth (site slugs need SITE_TOKEN, pages need
// PUBLISH_TOKEN, both fail closed when unset) + slug validation + R2 key.
// Returns a Response on rejection, else { isSite, key }.
function bearerToken(request) {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
}

function authorizeWrite(request, env, slug) {
  const token = bearerToken(request);
  const site = siteKey(slug);
  const isSite = site !== null;
  const expected = isSite ? env.SITE_TOKEN : env.PUBLISH_TOKEN;
  if (!expected || token !== expected) {
    return new Response("unauthorized\n", { status: 401 });
  }
  if (isSite ? site === "" : !SLUG_RE.test(slug)) {
    return new Response("invalid slug\n", { status: 400 });
  }
  return { isSite, key: isSite ? site : `pages/${slug}/index.html` };
}

function publishedUrl(slug, isSite) {
  if (!isSite) return `https://pages.agentkit.sbs/${slug}`;
  if (slug === "_pages-index") return "https://pages.agentkit.sbs/";
  if (slug === "_site") return "https://agentkit.sbs/";
  return `https://agentkit.sbs/${slug.slice(SITE_PREFIX.length)}`;
}

async function handlePublish(request, env, slug) {
  const gate = authorizeWrite(request, env, slug);
  if (gate instanceof Response) return gate;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_PAGE_BYTES) {
    return new Response("page must be 1 byte to 5 MB\n", { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_PAGE_BYTES) {
    return new Response("page must be 1 byte to 5 MB\n", { status: 413 });
  }
  await env.PAGES.put(gate.key, body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  return Response.json({ ok: true, slug, url: publishedUrl(slug, gate.isSite) });
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
  return Response.json({ ok: true, path, url: `https://agentkit.sbs/${path}` });
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
  const gate = authorizeWrite(request, env, slug);
  if (gate instanceof Response) return gate;
  const existing = await env.PAGES.head(gate.key);
  if (!existing) return new Response("not found\n", { status: 404 });
  await env.PAGES.delete(gate.key);
  return Response.json({ ok: true, deleted: slug });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    const path = url.pathname.replace(/\/+$/, "").replace(/^\/+/, "");

    if (request.method === "GET" && path.startsWith("api/site-list/")) {
      return handleAssetList(request, env, path.slice("api/site-list/".length));
    }
    if (request.method === "PUT" && path.startsWith("api/site/")) {
      return handleAssetWrite(request, env, path.slice("api/site/".length));
    }
    if (request.method === "DELETE" && path.startsWith("api/site/")) {
      return handleAssetDelete(request, env, path.slice("api/site/".length));
    }
    if (request.method === "PUT" && path.startsWith("api/pages/")) {
      return handlePublish(request, env, path.slice("api/pages/".length));
    }
    if (request.method === "DELETE" && path.startsWith("api/pages/")) {
      return handleDelete(request, env, path.slice("api/pages/".length));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405 });
    }

    if (host === "agentkit.sbs" || host === "www.agentkit.sbs") {
      if (path === "") return servePage(env, "_site/index.html", BASE_HEADERS);
      if (isDocsPath(path)) {
        const assetKey = docsAssetKey(path);
        if (assetKey) return serveAsset(env, assetKey, path);
        if (!SITE_PAGE_RE.test(path)) return html(404, NOT_FOUND, DOCS_HEADERS);
        return servePage(env, `_site/${path}/index.html`, DOCS_HEADERS);
      }
      if (!SLUG_RE.test(path)) return html(404, NOT_FOUND);
      return servePage(env, `_site/${path}/index.html`, BASE_HEADERS);
    }
    if (path === "") {
      return servePage(env, "_site/pages-index.html", PAGE_HEADERS);
    }
    if (!SLUG_RE.test(path)) return html(404, NOT_FOUND, PAGE_HEADERS);
    return servePage(env, `pages/${path}/index.html`, PAGE_HEADERS);
  },
};
