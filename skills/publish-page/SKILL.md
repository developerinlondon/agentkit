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

5. **Verify before reporting**: load the printed URL in headless Chromium at
   ~1280 px wide, screenshot BOTH themes (flip via the toggle), and Read every
   figure. A clipped, illegible, or wrong-theme figure means fix and re-publish.
   Never report the URL of an unviewed page.
6. **Give the user the URL** it prints (`https://pages.agentkit.sbs/<slug>`).
   That URL is live immediately.

## Page design — the house style is built in

Pages should look designed, not dumped. The doc/deck themes carry the house
identity automatically (**dark navy** ground `#071224→#0a1c38`, ink `#dce7f5`,
green accent `#34d3a6`, gold `#e8b444`, panels `#102847`, lines `#1e3a5f`,
mono eyebrows) — never re-explain or re-style these basics. Also automatic, no
agent action needed: a **dark/light theme toggle** (persisted; mermaid
re-renders on flip), a **TOC dot rail** with smooth scrolling on docs with ≥3
`h2` sections, prev/next **nav buttons** on decks, and **hover lift/glow** on
every card and diagram node. Add `data-tip="text"` to any node for a hover
tooltip.

**Be illustrative by default.** Structure every doc page as sections and pick the
strongest component for each idea — don't produce walls of prose.

**Route every visual by what the concept IS**, never by the tool you used last:

| Concept                                                 | Treatment                                     | Never                                                                         |
| ------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| System topology, trust/ownership boundaries             | `diagram` skill centerpiece                   | mermaid — auto-layout destroys boundary semantics                             |
| Deployable inventory, ≤7 nodes, relationships secondary | `.iso` kit + `.edge` connectors               | `diagram` skill (overkill)                                                    |
| Linear pipeline, all edges forward, stages need prose   | `.arch` flat kit                              | —                                                                             |
| Flow with a loop-back, gate, or failure branch          | `diagram` skill                               | `.flow`/`.arch`/`.fbox` — box kits cannot draw a backward edge                |
| Ordered message exchange, ≥3 participants               | mermaid `sequenceDiagram`                     | hand-drawn — sole exception: avoiding the mermaid runtime (see figure budget) |
| State machine >5 states with guards/terminals           | mermaid `stateDiagram-v2`                     | —                                                                             |
| State machine ≤5 states, transitions carry the meaning  | `diagram` skill                               | mermaid (generic)                                                             |
| Comparison, N options × M criteria, cells are prose     | markdown table                                | any diagram                                                                   |
| Comparison of structurally different options, ≤3        | `diagram` skill mirrored halves               | table (flattens the structural point)                                         |
| Hierarchy/taxonomy ≤3 levels                            | `diagram` skill tree — lines + text, no boxes | mermaid flowchart TD                                                          |
| Quantitative, ≥5 data points                            | inline SVG chart (discipline below)           | mermaid, chart libraries                                                      |
| ≤4 numbers                                              | `.chips` or a table row                       | a chart                                                                       |
| Independent items, no edges between them                | `.cards` grid                                 | any diagram — no edges = decorated list                                       |

A table beats a diagram when any of these holds: cells are full sentences; the
relation is "X has property Y", not "X acts on Y"; ≥6 uniform rows; the
reader's task is lookup, not path-following; item order is arbitrary.

**Figure budget.** Exactly one centerpiece diagram — the figure that answers the
page title's question — plus 2–5 supporting figures; a doc with ≥6 h2 sections
but fewer than 3 figures is under-illustrated. Never diagram
two-nodes-one-arrow (a sentence), items without relationships (`.cards`), or a
single before/after (`.callout`). Captions are one sentence with no "and"
joining two subjects — a caption that needs "and" is two figures. Ask the
`diagram` skill for canvases ≤1000 px wide (its hard ceiling is 1200 px with
all fonts ≥18 px): the column renders figures at ~979 px, and wider canvases
scale handwriting below legibility. Mermaid inlines
~3.4 MB once — if the page already carries 3+ inline SVG figures, draw the
sequence/state diagram with the `diagram` skill instead.

- **Diagram markup** — never ASCII art. Wrap EVERY diagram in
  `<div class="figure">…<div class="figcaption"><strong>Name</strong> — what it shows</div></div>`
  with a caption describing the content (say "Publish flow — from agent to live
  page", never the technology used to draw it). CRITICAL for markdown files:
  leave a BLANK LINE after `<div class="figure">` and before the closing
  markup — CommonMark otherwise swallows a fence inside an HTML block and the
  page silently shows literal backticks instead of a diagram.
  - **Hand-crafted architecture/explainer diagrams (highest quality)** → the
    `diagram` skill: author Excalidraw JSON per its methodology, render to
    self-contained SVG, inline the SVG inside a `.figure` with a semantic
    caption. Zero page runtime. Prefer this for the centerpiece diagram of a
    page; use the kits below for quick supporting visuals.
  - **System/architecture topology** → the isometric kit (the standout look):
    `<div class="iso"><div class="iso-node hot"><div class="tile"><div class="side"></div><div class="top"><div class="glyph">SVG</div></div></div><div class="tag">name</div></div>…</div>`
    Variants `.hot` (green) / `.gold` for emphasis. Draw each glyph as a simple
    inline 24×24 SVG outline icon (stroke `#8fa8c7`, or `#34d3a6`/`#e8b444` on
    emphasized nodes, stroke-width 1.5, fill none) matching the node's meaning —
    a database cylinder, a globe, a cloud, a terminal chevron, a bot face.
  - **Drawn connectors (draw.io-style)**: give nodes `id="n1"` etc. and declare
    edges anywhere inside the same `.figure`:
    `<span class="edge" data-from="n1" data-to="n2" data-label="PUT"></span>`
    — the theme draws glowing curved arrows with labels between the node
    centers automatically, and redraws them on resize and theme flip. Works
    over `.iso` tiles and `.arch` nodes alike.
  - **Pipelines/flows with descriptions** → the premium flat kit:
    `<div class="arch"><div class="arch-row"><div class="arch-node hot"><svg class="ic">…</svg><div class="nm">Name</div><div class="ds">detail</div></div></div><div class="arch-join">edge label</div>…</div>`
  - **Sequences, state machines, dense graphs, gantt** → mermaid fences (the
    runtime is auto-inlined, themed to the navy palette; costs ~3.4 MB of the
    5 MB cap, leaving ~1.4 MB for content):
    ````
    <div class="figure">

    ```mermaid
    sequenceDiagram
      agent->>worker: PUT page
    ```

    <div class="figcaption"><strong>Publish sequence</strong> — write path</div>
    </div>
    ````
  - **Charts (data)** → hand-built inline SVG following chart discipline: thin
    marks, one axis only (never dual-axis), a muted recessive grid, series
    colors from the accent family, direct labels over legends when ≤ 4 series,
    text in ink/muted tokens never in series colors. If a `dataviz` skill is
    available in the harness, load it and follow it; these rules are the
    baked-in fallback so charts come out right on any harness.
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
