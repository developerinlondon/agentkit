const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){0,3}$/;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

// Slugs the site deploy flow may write, gated by SITE_TOKEN instead of
// PUBLISH_TOKEN so a leaked page-publish token cannot deface the site.
const SITE_SLUGS = { "_site": "_site/index.html", "_pages-index": "_site/pages-index.html" };

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

async function handlePublish(request, env, slug) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const isSite = Object.hasOwn(SITE_SLUGS, slug);
  const expected = isSite ? env.SITE_TOKEN : env.PUBLISH_TOKEN;
  if (!expected || token !== expected) {
    return new Response("unauthorized\n", { status: 401 });
  }
  if (!isSite && !SLUG_RE.test(slug)) {
    return new Response("invalid slug\n", { status: 400 });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_PAGE_BYTES) {
    return new Response("page must be 1 byte to 5 MB\n", { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_PAGE_BYTES) {
    return new Response("page must be 1 byte to 5 MB\n", { status: 413 });
  }
  const key = isSite ? SITE_SLUGS[slug] : `pages/${slug}/index.html`;
  await env.PAGES.put(key, body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  const url = slug === "_site"
    ? "https://agentkit.sbs/"
    : slug === "_pages-index"
    ? "https://pages.agentkit.sbs/"
    : `https://pages.agentkit.sbs/${slug}`;
  return Response.json({ ok: true, slug, url });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    const path = url.pathname.replace(/\/+$/, "").replace(/^\/+/, "");

    if (request.method === "PUT" && path.startsWith("api/pages/")) {
      return handlePublish(request, env, path.slice("api/pages/".length));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405 });
    }

    if (host === "agentkit.sbs" || host === "www.agentkit.sbs") {
      if (path !== "") return html(404, NOT_FOUND);
      return servePage(env, "_site/index.html", BASE_HEADERS);
    }
    if (path === "") {
      return servePage(env, "_site/pages-index.html", PAGE_HEADERS);
    }
    if (!SLUG_RE.test(path)) return html(404, NOT_FOUND, PAGE_HEADERS);
    return servePage(env, `pages/${path}/index.html`, PAGE_HEADERS);
  },
};
