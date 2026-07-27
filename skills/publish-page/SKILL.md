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
2. **Pick a logical name yourself**: short, descriptive, lowercase `a-z0-9-`,
   e.g. `fcar-q3-report`, `auth-flow-design`. The URL is derived as
   HMAC(slug key, name) — cryptic hex nobody can guess, but deterministic: the
   same name republished updates the SAME URL, and `--delete --name <name>`
   finds it again. No mapping to store.
   Use `--slug <path>` INSTEAD only when the user explicitly wants a
   human-readable URL (up to 4 `/` segments).
3. **Pick the template yourself**: `doc` (default, report/article), `deck`
   (slides — split on `---` lines in markdown), `raw` (complete HTML published
   as-is).
4. **Run** (one-time per machine: `cd <skill-dir> && bun install`):

```bash
bun <skill-dir>/publish.ts --name <name> --file <content-file> [--template doc|deck|raw] [--title "Title"]
bun <skill-dir>/publish.ts --name <name> --delete    # remove a page you published
```

5. **Give the user the URL** it prints (`https://pages.agentkit.sbs/<slug>`).
   That URL is live immediately.

## Page design — the house style is built in

Pages should look designed, not dumped. The doc/deck themes carry the house
identity automatically (**dark navy** ground `#071224→#0a1c38`, ink `#dce7f5`,
green accent `#34d3a6`, gold `#e8b444`, panels `#102847`, lines `#1e3a5f`,
mono eyebrows) — never re-explain or re-style these basics.

**Be illustrative by default.** Structure every doc page as sections and pick the
strongest component for each idea — don't produce walls of prose:

- **Diagrams: use mermaid fences** — they render as real diagrams (the runtime
  is inlined automatically, only on pages that use it). Prefer mermaid over
  ASCII art for flows, architectures, sequences:
  ````
  ```mermaid
  flowchart LR
    A[agent] -->|PUT| W[Worker] --> R2[(R2)]
  ```
  ````
- **Section headers**: `<div class="kicker">01 — topic</div>` before an `## h2`.
- **Enumerable concepts** (features, components, principles): a 2-column grid —
  `<div class="cards"><div class="card"><h3><code>name</code></h3><p>…</p></div>…</div>`
- **Key decisions / warnings**: `<div class="callout"><strong>Label.</strong> text</div>`
- **Metadata rows**: `<div class="chips"><span class="chip"><strong>Status</strong> live</span>…</div>`
- **Pipeline/stage boxes** (when mermaid is overkill):
  `<div class="flow"><div class="frow"><div class="fbox gate"><span class="t">stage</span><span class="d">detail</span></div>…</div><div class="arrow">▼</div>…</div>`
  — `.fbox` variants: `.gate` (gold), `.ok` (green), `.deny` (red).
- **Facts with columns**: markdown tables (themed automatically).

All of these work inside markdown files — markdown passes raw HTML through.
Decks: one idea per slide, kicker + h2 + a few bullets or one diagram/card grid;
put heavy diagrams on their own slide. Raw pages: full freedom, but reuse the
navy tokens above so pages feel like one product.

## Requirements and behavior

- Publish token: `~/.config/agentkit/pages-token` (mint at agentkit.sbs).
- Themes are bundled with the skill; if a clone of `gitlab.com/agentkit/agentkit-pages`
  exists at `~/code/agentkit-pages` (override: `AGENTKIT_PAGES_REPO`), the publish
  also commits `src/` + `dist/` there for canonical history — otherwise it
  serves-only and says so. Endpoint override: `AGENTKIT_PAGES_ENDPOINT`.
- Pages are **public by slug** (unguessable is NOT private) — never publish
  secrets, tokens, or personal data. Accounts/private pages are a coming phase.
  "Without asking" covers slug/template/mechanics only: when the user asked to
  publish, publish. When YOU are proposing the page and its content derives from
  private material (client data, internal repos, credentials-adjacent config),
  confirm with the user before publishing.
- Same name (or slug) republished overwrites silently, and on machines without
  the pages repo clone there is no git history to recover from — pick
  distinctive names, reuse one only when deliberately updating that page.
  `--no-git` skips the canonical commit explicitly (same effect as a missing
  clone).
- Slug key: `~/.config/agentkit/pages-slug-key`, auto-generated on first use,
  deliberately separate from the auth token so credential rotation never
  changes a URL. Copy the SAME key to other machines (alongside the token) or
  the same name derives different URLs per machine. Losing the key strands
  HMAC-derived pages from `--name` reach — recover slugs from the pages repo
  `meta.yaml` and manage them via `--slug`.
- Pages must be self-contained: inline all CSS/JS, `data:` URIs for images. The
  serving CSP blocks every external request. Max 5 MB.
- Errors are loud; fix and re-run. Do not fall back to pasting the content into
  chat without saying the publish failed.
