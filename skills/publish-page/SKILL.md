---
name: publish-page
description: Publish agent output (reports, docs, slide decks, dashboards) as a web page at pages.agentkit.sbs — use whenever rich HTML output beats chat text, when the user asks to publish/share a page, or when producing a report/deck worth keeping at a stable URL.
---

# publish-page

Publish a page to AgentKit Pages. Pages are **public** in the current phase —
never publish secrets or private data.

## Usage

```bash
bun <skill-dir>/publish.ts --slug <slug> --file <content-file> \
  [--template doc|deck|raw] [--title "Page title"] [--no-git]
```

- `--slug` — URL path, lowercase `a-z0-9-` with up to 4 `/` segments (e.g. `reports/q3-audit`).
  Republishing the same slug updates the same URL.
- `--file` — content: markdown (`.md`) or HTML fragment/full page (`.html`).
- `--template`
  - `doc` (default) — report/article chrome.
  - `deck` — slide deck; split slides on `---` lines (markdown) or `<hr>` (HTML).
    Arrow keys / swipe / dots navigate; print gives one slide per page.
  - `raw` — file is a complete self-contained HTML page, published as-is.
- `--no-git` — skip the canonical commit (serving write only; use when the pages
  repo is unavailable).

Prints the live URL on success. Errors are loud; fix and re-run.

## What it does

1. Renders content through the theme (from the agentkit-pages repo clone).
2. `PUT`s the rendered HTML to the Worker — the URL is live immediately.
3. Commits `src/<slug>/` + `dist/<slug>/` to the agentkit-pages repo (canonical
   history) and pushes. The pages repo is a content datastore: direct commits to
   its default branch are by design.

## Config

| Setting | Source | Default |
| --- | --- | --- |
| Endpoint | `AGENTKIT_PAGES_ENDPOINT` | `https://pages.agentkit.sbs` |
| Token | `~/.config/agentkit/pages-token` | required |
| Pages repo clone | `AGENTKIT_PAGES_REPO` | `~/code/agentkit-pages` |

## Rules for page content

- Self-contained only: inline all CSS/JS, `data:` URIs for images. No CDN links.
- The serving CSP allows inline style/script and blocks all external requests.
- Max 5 MB per page.
