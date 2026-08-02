import { deviceTokensForUser, invitesForUserPages, pagesForUser } from "./accounts.js";
import { escapeHtml } from "./ui.js";

export async function dashboard(env, user) {
  const [pages, invites, devices] = await Promise.all([
    pagesForUser(env, user.id),
    invitesForUserPages(env, user.id),
    deviceTokensForUser(env, user.id),
  ]);
  const invitesByPage = Map.groupBy(invites, (invite) => invite.page_slug);
  const cards = pages.map((page) => `
    <article>
      <h2><a href="/access?return_to=${encodeURIComponent(`${env.PAGES_URL}/${page.slug}`)}">${escapeHtml(page.title || page.slug)}</a></h2>
      <p><code>${escapeHtml(page.slug)}</code> · private${page.share_token_hash ? " · sharing on" : ""}</p>
      ${(invitesByPage.get(page.slug) || []).map((invite) =>
        `<p>Access: ${escapeHtml(invite.email)}</p>`).join("")}
      <form method="post" action="/api/pages/${escapeHtml(page.slug)}/share">
        <input type="hidden" name="enabled" value="${page.share_token_hash ? "false" : "true"}">
        <button>${page.share_token_hash ? "Turn sharing off" : "Create sharing link"}</button>
      </form>
      <form method="post" action="/api/pages/${escapeHtml(page.slug)}/invites">
        <label>Invite by Assay email <input type="email" name="email" required></label>
        <button>Invite</button>
      </form>
      <form method="post" action="/api/pages/${escapeHtml(page.slug)}/invites/remove">
        <label>Remove email access <input type="email" name="email" required></label>
        <button>Remove</button>
      </form>
    </article>`).join("");
  const deviceCards = devices.map((device) => `
    <li><strong>${escapeHtml(device.name)}</strong>${device.last_used_at ? " · active" : " · unused"}
      <form method="post" action="/api/devices/${escapeHtml(device.token_hash)}/revoke">
        <button>Revoke</button>
      </form>
    </li>`).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>AgentKit Pages</title><style>
body{font:16px system-ui;max-width:58rem;margin:3rem auto;padding:0 1rem;background:#fafafa;color:#18181b}
header{display:flex;justify-content:space-between;align-items:center}article{background:white;padding:1.25rem;margin:1rem 0;border:1px solid #ddd;border-radius:12px}
form{display:inline-flex;gap:.5rem;margin:.5rem .5rem 0 0}button,input{font:inherit;padding:.5rem}a{color:#4338ca}
</style><header><div><h1>Your pages</h1><p>Signed in as ${escapeHtml(user.email)}</p></div><form method="post" action="/logout"><button>Sign out</button></form></header>
${cards || "<p>You have not published a page yet.</p>"}
<section><h2>Publishing devices</h2><ul>${deviceCards || "<li>No publishing devices.</li>"}</ul></section>`;
}
