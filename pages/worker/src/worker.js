const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){0,3}$/;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'none'",
};

function html(status, body) {
  return new Response(body, { status, headers: PAGE_HEADERS });
}

const NOT_FOUND = `<!doctype html><meta charset="utf-8"><title>Not found</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh">
<div style="text-align:center"><h1 style="letter-spacing:-0.02em">404</h1>
<p>No page lives at this address.</p></div>`;

async function servePage(env, key) {
  const obj = await env.PAGES.get(key);
  if (!obj) return html(404, NOT_FOUND);
  return html(200, obj.body);
}

async function handlePublish(request, env, slug) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.PUBLISH_TOKEN || token !== env.PUBLISH_TOKEN) {
    return new Response("unauthorized\n", { status: 401 });
  }
  if (slug !== "_site" && !SLUG_RE.test(slug)) {
    return new Response("invalid slug\n", { status: 400 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_PAGE_BYTES) {
    return new Response("page must be 1 byte to 5 MB\n", { status: 413 });
  }
  const key = slug === "_site" ? "_site/index.html" : `pages/${slug}/index.html`;
  await env.PAGES.put(key, body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  const url = slug === "_site"
    ? "https://agentkit.sbs/"
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
      return servePage(env, "_site/index.html");
    }
    if (path === "") {
      return servePage(env, "_site/pages-index.html");
    }
    if (!SLUG_RE.test(path)) return html(404, NOT_FOUND);
    return servePage(env, `pages/${path}/index.html`);
  },
};
