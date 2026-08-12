import { deviceTokensForUser, invitesForUserPages, pagesForUser } from "./accounts.js";
import { escapeHtml, MARK, shell } from "./ui.js";

function day(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function shareRow(page) {
  const on = Boolean(page.share_token_hash);
  const slug = escapeHtml(page.slug);
  return `<div class="row">
    <span class="grant">${on ? "Anyone with the link" : "Link sharing is off"}
      <span class="how">${on ? "no sign-in needed" : "only invited people can open it"}</span></span>
    <form method="post" action="/api/pages/${slug}/share">
      <input type="hidden" name="enabled" value="${on ? "false" : "true"}">
      <button class="${on ? "quiet" : ""}">${on ? "Turn off" : "Create a link"}</button>
    </form>
  </div>`;
}

function inviteRow(slug, email) {
  return `<div class="row">
    <span class="grant">Access: ${escapeHtml(email)}
      <span class="how">signs in to open it</span></span>
    <form method="post" action="/api/pages/${escapeHtml(slug)}/invites/remove">
      <input type="hidden" name="email" value="${escapeHtml(email)}">
      <button class="quiet">Remove</button>
    </form>
  </div>`;
}

function revealRow(url) {
  return `<div class="row reveal">
    <span class="grant"><strong>Your sharing link</strong>
      <span class="how">shown once — copy it now</span>
      <a class="link-out mono" href="${escapeHtml(url)}">${escapeHtml(url)}</a></span>
  </div>`;
}

function pageCard(env, page, invites, flash) {
  const slug = escapeHtml(page.slug);
  const address = `${env.PAGES_URL}/${page.slug}`;
  const open = `/access?return_to=${encodeURIComponent(address)}`;
  const shared = Boolean(page.share_token_hash);
  return `<article class="card">
    <div class="card-head">
      <h2><a href="${open}">${escapeHtml(page.title || page.slug)}</a></h2>
      <span class="pill${shared ? " on" : ""}">${shared ? "Shared by link" : "Private"}</span>
    </div>
    <p class="meta"><a class="mono addr" href="${escapeHtml(open)}">${
    escapeHtml(address.replace(/^https:\/\//, ""))
  }</a> &middot; updated ${day(page.updated_at)}</p>
    <div class="ledger">
      ${flash ? revealRow(flash.url) : ""}
      <div class="row">
        <span class="grant">You <span class="how">owner</span></span>
      </div>
      ${invites.map((invite) => inviteRow(page.slug, invite.email)).join("")}
      ${shareRow(page)}
    </div>
    <form class="invite" method="post" action="/api/pages/${slug}/invites">
      <input type="email" name="email" required placeholder="name@example.com"
        aria-label="Give someone access to ${slug} by email">
      <button class="primary">Give access</button>
    </form>
  </article>`;
}

function deviceCard(device) {
  const used = device.last_used_at ? `last used ${day(device.last_used_at)}` : "never used";
  return `<article class="card">
    <div class="card-head">
      <h2>${escapeHtml(device.name)}</h2>
      <span class="pill">${used}</span>
    </div>
    <p class="meta"><code>${escapeHtml(device.scopes)}</code> &middot; expires ${day(device.expires_at)}</p>
    <div class="ledger">
      <div class="row">
        <span class="grant">Can publish to your account
          <span class="how">until you revoke it</span></span>
        <form method="post" action="/api/devices/${escapeHtml(device.token_hash)}/revoke">
          <button class="quiet">Revoke</button>
        </form>
      </div>
    </div>
  </article>`;
}

function section(title, count, cards, blank) {
  return `<h2 class="label">${title}<span class="count">${count}</span></h2>
    ${cards || `<div class="blank">${blank}</div>`}`;
}

export async function dashboard(env, user, flash = null) {
  const [pages, invites, devices] = await Promise.all([
    pagesForUser(env, user.id),
    invitesForUserPages(env, user.id),
    deviceTokensForUser(env, user.id),
  ]);
  const byPage = Map.groupBy(invites, (invite) => invite.page_slug);
  const body = `<header class="top">
      <span class="brand" style="color:var(--accent)">${MARK}<b style="color:var(--text)">agentkit pages</b></span>
      <span class="who">Signed in as <span class="mono">${escapeHtml(user.email)}</span>
        <form method="post" action="/logout" style="display:inline-flex;margin-left:.6rem">
          <button>Sign out</button></form></span>
    </header>
    ${
    section(
      "Pages",
      pages.length,
      pages.map((page) =>
        pageCard(env, page, byPage.get(page.slug) || [], flash?.slug === page.slug ? flash : null)
      ).join(""),
      `<p>Nothing published yet.</p><p class="note">Your agent publishes one for you.</p>
       <code>PUT /api/pages/&lt;slug&gt;</code>`,
    )
  }
    ${
    section(
      "Publishing devices",
      devices.length,
      devices.map(deviceCard).join(""),
      `<p>No device can publish to this account.</p>
       <p class="note">Connect one at <code>/device</code>.</p>`,
    )
  }`;
  return shell("AgentKit Pages", body);
}
