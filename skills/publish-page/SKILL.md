---
name: publish-page
description: Publish content as a live web page with a stable URL (AgentKit Pages, self-hosted artifacts). Use AUTOMATICALLY whenever the user asks to publish/share/host a page, make an artifact/report/dashboard/slide deck/design doc viewable in a browser, or when rich formatted output would clearly beat chat text. Also triggers on "make a page", "put this on a page", "publish this", "as a deck/slides", "share a link". Renders markdown or HTML through themes and returns the live URL.
---

# publish-page

You publish pages **end-to-end without asking the user for details**. Like creating
an artifact: decide, publish, hand back the URL.

## Automated workflow

1. **Write the content** to a temp file (scratchpad). Markdown for docs/decks;
   complete self-contained HTML for bespoke pages (dashboards, visualizations).
2. **Pick the slug yourself**: short, descriptive, lowercase `a-z0-9-`, up to 4
   `/` segments, e.g. `reports/fcar-q3`, `designs/auth-flow`, `decks/roadmap`.
   Republishing the same slug updates the same URL — reuse the slug when
   iterating on the same page.
3. **Pick the template yourself**: `doc` (default, report/article), `deck`
   (slides — split on `---` lines in markdown), `raw` (complete HTML published
   as-is).
4. **Run** (one-time per machine: `cd <skill-dir> && bun install`):

```bash
bun <skill-dir>/publish.ts --slug <slug> --file <content-file> [--template doc|deck|raw] [--title "Title"]
```

5. **Give the user the URL** it prints (`https://pages.agentkit.sbs/<slug>`).
   That URL is live immediately.

## Requirements and behavior

- Publish token: `~/.config/agentkit/pages-token` (mint at agentkit.sbs; on eda
  it is already provisioned, canonical copy in OpenBao
  `secrets/platform/agentkit/pages`).
- Themes are bundled with the skill; if a clone of `gitlab.com/agentkit/agentkit-pages`
  exists at `~/code/agentkit-pages` (override: `AGENTKIT_PAGES_REPO`), the publish
  also commits `src/` + `dist/` there for canonical history — otherwise it
  serves-only and says so. Endpoint override: `AGENTKIT_PAGES_ENDPOINT`.
- Pages are **public by slug** (unguessable is NOT private) — never publish
  secrets, tokens, or personal data. Accounts/private pages are a coming phase.
- Pages must be self-contained: inline all CSS/JS, `data:` URIs for images. The
  serving CSP blocks every external request. Max 5 MB.
- Errors are loud; fix and re-run. Do not fall back to pasting the content into
  chat without saying the publish failed.
