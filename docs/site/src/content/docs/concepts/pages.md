---
title: Pages
description: The self-hosted artifact publisher — Assay accounts, private pages, stable URLs, and controlled sharing.
sidebar:
  order: 6
---

An agent finishes something worth looking at — a report, an architecture page, a deck — and chat is
the wrong container for it. Pages is the other end: one command renders that content through a house
theme and returns a live URL.

:::note[New pages are private]
Publishing requires an Assay account and creates a page visible only to its owner. The owner can
create a revocable sharing link or grant access to another verified Assay email from
`https://account.agentkit.sbs/dashboard`. Pages created before accounts remain public during the
migration; an old unguessable slug is still not access control.
:::

## The serving path

```mermaid
flowchart LR
  agent["agent output<br/>markdown or HTML"] --> pub["publish.ts<br/>theme · figure lint · 5 MB gate"]
  pub -- "device authorization" --> assay["Assay Auth<br/>identity"]
  pub -- "PUT /api/pages/&lt;slug&gt;<br/>device credential" --> account["account.agentkit.sbs<br/>trusted control plane"]
  browser["browser"] -- "host-only session" --> account
  account -- "10 minute page capability" --> pages["pages.agentkit.sbs<br/>untrusted content"]
  browser -- "capability or share link" --> pages
  account --> worker["Cloudflare Worker"]
  pages --> worker
  worker --> r2["R2 bucket<br/>the served copy"]
  worker --> d1["D1<br/>owners · sessions · sharing"]
  account -. "OIDC code + PKCE" .-> assay
  pub -. "with --git" .-> repo["git clone<br/>explicit archival"]
```

Three parts in the serving path — a skill that renders and uploads, a Worker that serves, an object
store that holds the rendered HTML — plus an optional canonical clone.

### The Worker contract

| Origin                      | Method        | Path                | Behaviour                                                                                     |
| --------------------------- | ------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `account.agentkit.sbs`      | `PUT`         | `/api/pages/<slug>` | Device bearer required · owner-only updates · new pages private · 5 MB and per-account quotas |
| `account.agentkit.sbs`      | `DELETE`      | `/api/pages/<slug>` | Device bearer required · owner-only · 404 when absent                                         |
| `account.agentkit.sbs`      | `GET`         | `/dashboard`        | Owner pages, invites, sharing controls, and publishing devices                                |
| `account.agentkit.sbs`      | `POST`        | `/api/device/*`     | Bounded device authorization for the publish skill                                            |
| `pages.agentkit.sbs`        | `GET`, `HEAD` | `/<slug>`           | Public/legacy page, share token, or account-issued page capability; every other method is 404 |
| apex (and `www`)            | `PUT`         | `/api/site/<path>`  | Site-token only · docs assets with real filenames and extensions · same 5 MB rule             |
| apex (and `www`)            | `GET`, `HEAD` | `/<path>`           | Marketing and documentation keyspace; the root is the site index                              |
| an unconfigured Worker host | any           | any                 | 404                                                                                           |

Routing and credentials both split by host. The host-only account session is never sent with
rendered content. A private-page request visits the account origin to prove ownership or an invite,
then returns with a random capability scoped to that one page for ten minutes. This keeps arbitrary
inline JavaScript on a published page outside the dashboard's same-origin boundary.

:::note[The docs subtree is a deliberate relaxation]
This documentation is served from the site keyspace under a `docs/` prefix, and that subtree is the
one place the Worker accepts real filenames with extensions, dotted path segments (a version
directory like `docs/0.4`), deeper nesting, and a looser CSP that permits `'self'` scripts and
`wasm-unsafe-eval` — a generated site addresses hashed bundles and its search index needs WebAssembly.
Every one of those relaxations is confined to that prefix. Outside it the apex still answers only
`<slug>/index.html` under `default-src 'none'`.
:::

## Credentials have separate jobs

| Credential      | Grants                                                             | Storage                                               |
| --------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| slug key        | Derives a URL from a name; no network access                       | Local file, mode `0600`                               |
| device token    | `pages:write` / `pages:delete` for owned pages; expires in 90 days | Local file, mode `0600`; SHA-256 hash in D1           |
| browser session | Account dashboard and access-broker requests                       | Host-only secure HTTP-only cookie; SHA-256 hash in D1 |
| page capability | Read access to one page for ten minutes                            | URL parameter; SHA-256 hash and expiry in D1          |
| sharing token   | Read access to one page until its owner disables the link          | URL shown once; SHA-256 hash in D1                    |
| site token      | Writes the marketing and documentation `_site/` keyspace           | Worker secret, isolated from account publishing       |

The site-token separation remains mechanical: every site key is rooted at `_site/`, and the
published-page slug alphabet cannot express a leading underscore. A device-token holder cannot
address a site key at all.

Slugs are an HMAC-SHA256 of the name under the slug key, truncated to 20 hex characters. Deterministic,
so republishing the same name updates the same URL, and no name-to-slug mapping has to be stored
anywhere. The key is generated on first use under `~/.config/agentkit/pages-slug-key` — and because it
determines the URL, the _same_ key must be copied to other machines or the same name derives a
different URL per machine. The run says so when it generates one.

`--slug` overrides that with a readable path. Use it only when a person has to read, type or say the
URL aloud.

## Publishing

```
bun <skill-dir>/publish.ts --name <name> --file <content-file> \
  [--template doc|deck|raw] [--title "Title"] [--git]
bun <skill-dir>/publish.ts --name <name> --delete
```

| Flag               | Meaning                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `--name`           | The logical name; the slug is derived from it                                                      |
| `--slug`           | A readable path instead of a derived slug                                                          |
| `--file`           | The content — markdown for docs and decks, self-contained HTML for bespoke pages                   |
| `--template`       | `doc` (default), `deck`, or `raw` (published as-is)                                                |
| `--title`          | Overrides the title, which otherwise comes from the first heading, a `<title>`, or the page's name |
| `--delete`         | Remove a page you published                                                                        |
| `--no-git`         | Skip the canonical commit                                                                          |
| `--git`            | Explicitly archive source and rendered HTML in the canonical clone                                 |
| `--allow-bare-svg` | Suppress the bare-diagram refusal — blocked by a hook unless the user approved it                  |

On first use the skill opens Assay sign-in, shows a short device code, and stores the resulting
per-device credential. A rejected or expired credential repeats that flow automatically. Each
device is bounded to 60 publish/delete operations per minute in D1; a `429` carries `Retry-After`.
It then publishes end to end without asking about slug, template, or
mechanics. It does not skip verification: load the printed URL in headless Chromium, screenshot
both themes, and read every figure. **Never report the URL of an unviewed page.**

## Direct writes are blocked on purpose

[`pages-police`](/docs/reference/hooks/) refuses raw `curl`, `wget`, `httpie` and `xh` writes to the
publish API. Publishing
through the skill enforces the figure lint, the size cap and the canonical commit; a raw write bypasses
all three.

The hook matches command shapes, so it covers the convenient wrong path — the one an agent actually
takes — rather than every possible route to the API.

## Self-containment is enforced, not advised

A published page makes no external request of any kind. The serving headers set `default-src 'none'`
with inline-only styles and scripts, images and fonts only as `data:` URIs, and framing and form
submission blocked outright.

That is the environment, not a recommendation to authors: a page referencing a CDN simply does not load
that resource. So every page inlines everything — styles, scripts, fonts, images, and the diagram
runtime when a figure needs it.

The ceiling is 5 MB, checked twice on the way in (once against the declared length, once against the
actual bytes) and again client-side, with an empty body rejected too. The client-side check names the
tradeoff when a page is over: the inlined mermaid runtime alone accounts for roughly 3.4 MB, leaving a
diagram page about 1.4 MB for content, so a diagram-heavy page either splits or drops diagrams.

## The figure lint

One rule is enforced at publish time rather than left to taste. A baked diagram published outside a
figure island — or outside a container whose background uses the theme's diagram token — is refused.

The failure it prevents is specific: a dark-palette diagram dropped onto a page-supplied white
background is illegible in _both_ themes. There is a warning for the near miss too, when a page's own
styles hardcode white while carrying a baked diagram.

## The canonical clone

Canonical archival is deliberately explicit because repository visibility is independent of the
page ACL. With `--git` and a canonical clone present, publishing writes the unrendered source and
metadata, the rendered HTML, and a commit **scoped by path** to exactly those files, then pushes it.
A failed push warns that the commit is local only.

```
themes/          versioned page chrome
src/<slug>/      page source: content + metadata
dist/<slug>/     rendered HTML — the archived copy of what was uploaded
```

The path scoping is deliberate: the clone is long-lived and shared, and a bare commit would sweep in
anything else that happened to be staged.

Without `--git`, no page content enters the canonical repository. Without a clone, publishing still
works — it warns once that it is using the skill's bundled themes, which can lag the canonical ones,
and that no history is being recorded. That warning matters: a republish under an existing name
overwrites silently, and on a machine with no clone there is nothing to recover from.

Staleness runs both ways, and the clone is the side that is easiest to miss. Publishing prefers the
clone's themes whenever a clone exists, so a clone left behind its upstream serves older chrome than
the installed skill carries — while the renderer, which ships with the skill, stays current. The two
disagree inside a single page, and nothing fails: the upload succeeds and the page loads. A drift
warning does fire, but it names the bundled copy as the stale one either way, so in this direction
its advice is backwards. Pull the clone before publishing after an upgrade.
