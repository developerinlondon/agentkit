// `no-referrer` is not available here, however much the account UI would like
// it: a browser serialises the Origin of a form POST to the string `null`
// under that policy, so the same-origin check rejects every control on the
// page. `same-origin` still sends no referrer off-site, and an attacker's
// cross-origin POST still arrives with an origin that is not ours.
export const UI_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

// The serving CSP is `default-src 'none'` with only inline style allowed, so
// this interface has no script, no webfont and no image. Machine values carry
// the identity instead: every slug, scope, token and date is set in the
// monospace face, which is also the vernacular of the tool that publishes them.
const STYLES = `
:root { color-scheme: dark light; --radius: 10px; --ink: rgb(11, 12, 14); --surface: rgb(20, 22, 25); --raised: rgb(27, 30, 35); --line: rgb(36, 39, 44); --line-soft: rgb(28, 31, 36); --text: rgb(232, 234, 237); --muted: rgb(150, 156, 165); --accent: rgb(245, 167, 66); --accent-ink: rgb(8, 9, 10); --accent-quiet: rgba(245, 167, 66, 0.13); --danger: rgb(239, 139, 122); }
@media (prefers-color-scheme: light) {
  :root { --ink: rgb(251, 250, 248); --surface: rgb(255, 255, 255); --raised: rgb(246, 246, 244); --line: rgb(226, 226, 223); --line-soft: rgb(238, 238, 236); --text: rgb(25, 26, 28); --muted: rgb(99, 103, 110); --accent: rgb(154, 92, 7); --accent-ink: rgb(255, 255, 255); --accent-quiet: rgba(154, 92, 7, 0.08); --danger: rgb(163, 52, 28); }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem 5rem;
  background: var(--ink); color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 54rem; margin: 0 auto; }
code, .mono, input {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

.top {
  display: flex; flex-wrap: wrap; gap: 1rem;
  align-items: center; justify-content: space-between;
  padding-bottom: 1.25rem; border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: .6rem; }
.brand svg { display: block; }
.brand b { font-weight: 600; letter-spacing: -0.01em; font-size: 1rem; }
.who { color: var(--muted); font-size: .8125rem; }
.who .mono { color: var(--text); }

/* The chevron marks a section the way a prompt marks a line: it is the one
   motif carried from the agentkit mark, so nothing else needs decoration. */
.label {
  display: flex; align-items: baseline; gap: .5rem;
  margin: 2.25rem 0 .75rem;
  font-size: .6875rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .14em; color: var(--muted);
}
.label::before { content: "\\203A"; color: var(--accent); font-size: .9rem; line-height: 1; }
.label .count {
  margin-left: auto; letter-spacing: 0; text-transform: none;
  font-weight: 400; color: var(--muted);
}

.card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 1.1rem 1.15rem; margin-bottom: .85rem;
}
.card:target { outline: 2px solid var(--accent); outline-offset: 2px; }
.card-head {
  display: flex; flex-wrap: wrap; gap: .35rem .75rem;
  align-items: baseline; justify-content: space-between;
}
.card-head h2 { margin: 0; font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.01em; }
.card-head h2 a { color: inherit; text-decoration: none; }
.card-head h2 a:hover { color: var(--accent); }
.meta { margin: .3rem 0 0; font-size: .8125rem; color: var(--muted); }
.meta .addr { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
.meta .addr:hover { text-decoration: underline; text-underline-offset: 3px; }

/* The sharing link is minted once and never stored in the clear, so it is
   handed back in place rather than on a page the reader has to come back from. */
.row.reveal { background: var(--accent-quiet); border-radius: 8px; padding: .7rem .75rem; margin: .5rem 0; }
.row.reveal .link-out { margin-top: .35rem; }

.pill {
  font-size: .6875rem; font-weight: 600; letter-spacing: .04em;
  padding: .2rem .45rem; border-radius: 5px;
  border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
}
.pill.on { color: var(--accent); border-color: var(--accent); background: var(--accent-quiet); }

/* The access ledger: one row per way in. It answers the only question that
   matters on this screen — who can open this page right now. */
.ledger { margin-top: .9rem; border-top: 1px solid var(--line-soft); }
.row {
  display: flex; flex-wrap: wrap; gap: .5rem .75rem; align-items: center;
  padding: .6rem 0; border-bottom: 1px solid var(--line-soft);
}
.row .grant { flex: 1 1 14rem; min-width: 0; font-size: .875rem; overflow-wrap: anywhere; }
.row .how { color: var(--muted); font-size: .75rem; }
.empty { padding: .75rem 0; color: var(--muted); font-size: .8125rem; }

.row form { display: inline-flex; gap: .5rem; }
.invite { display: flex; gap: .5rem; flex-wrap: wrap; padding: .7rem 0 0; }
.invite input {
  flex: 1 1 13rem; min-width: 0;
  background: var(--raised); color: var(--text);
  border: 1px solid var(--line); border-radius: 7px;
  padding: .45rem .6rem; font-size: .8125rem;
}
.invite input::placeholder { color: var(--muted); }
.invite input:focus-visible, a:focus-visible, button:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

button {
  font: inherit; font-size: .8125rem; font-weight: 500;
  padding: .45rem .7rem; border-radius: 7px; cursor: pointer;
  background: var(--raised); color: var(--text); border: 1px solid var(--line);
}
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.primary:hover { filter: brightness(1.08); }
button.quiet { background: none; color: var(--muted); border-color: transparent; padding: .45rem .5rem; }
button.quiet:hover { color: var(--danger); border-color: var(--line); }

.blank {
  border: 1px dashed var(--line); border-radius: var(--radius);
  padding: 1.75rem 1.25rem; text-align: center; color: var(--muted);
}
.blank p { margin: 0 0 .5rem; }
.blank code {
  display: inline-block; margin-top: .25rem; font-size: .8125rem;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 6px; padding: .3rem .5rem; color: var(--text);
}
a { color: var(--accent); }
.link-out { display: block; margin-top: .9rem; font-size: .875rem; overflow-wrap: anywhere; }
.note { color: var(--muted); font-size: .8125rem; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

// The chevron and cursor bar from the agentkit mark, inline because the CSP
// forbids loading an image at all.
export const MARK = `<svg width="20" height="20" viewBox="0 0 32 32" role="img" aria-label="agentkit">
<path d="M6 9 L12 16 L6 23" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="16" y="19.5" width="10" height="3.5" rx="1.75" fill="currentColor"/></svg>`;

export function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLES}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}
