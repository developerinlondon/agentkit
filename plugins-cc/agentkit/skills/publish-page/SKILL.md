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
identity automatically (**deep neutral** ground `#0a0a0c→#131417`, ink `#eeeeee`,
blue accent `#79a8e7`, amber `#f5a742`, panels `#1b1d22`, lines `#2a2d34`,
mono eyebrows; light mode goes white-ground with a deep-blue accent and
auto-inverts baked diagrams) — never re-explain or re-style these basics. Also automatic, no
agent action needed: a **dark/light theme toggle** (persisted; mermaid
re-renders on flip), a **labelled section nav** — a sticky top bar built from the
page's `h2` titles, with the current section highlighted — on docs with ≥3 `h2`
sections. **Name every tab yourself whenever a title runs past ~28 characters** —
write the heading as raw HTML, which markdown passes straight through:
`<h2 data-nav="Estimate">Two to four weeks, not two months</h2>`. A derived tab
is a guess and is marked with an ellipsis to say so; a page whose nav reads
`Estimate · SSH · Language · Architecture` is doing the reader's work, one that
reads `Two to four weeks… · SSH is a day of work…` is not. Tabs are labels, not
sentences: one or two words, no trailing punctuation, and the full title stays
on hover, one persistent **deck nav bar** (progress, slide counter,
prev/next, toggle) with arrow/space/Home/End keys and swipe (backward swipe
may be claimed by the browser's history gesture),
**click-to-expand** on every `.figure`, and **hover lift/glow** on every card
and diagram node. Add `data-tip="text"` to any node for a hover tooltip.

**Be illustrative by default.** Structure every doc page as sections and pick the
strongest component for each idea — don't produce walls of prose.

**Route every visual by what the concept IS**, never by the tool you used last:

| Concept                                                                                                                     | Treatment                                               | Never                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Deployable inventory, ≤7 nodes, relationships secondary                                                                     | `.iso` kit + `.edge` connectors                         | `diagram` skill (overkill)                                                                                              |
| Linear pipeline, all edges forward, stages need prose                                                                       | `.arch` flat kit                                        | —                                                                                                                       |
| Independent items, no edges between them                                                                                    | `.cards` grid                                           | any diagram — no edges = decorated list                                                                                 |
| ≤4 numbers                                                                                                                  | `.chips` or a table row                                 | a chart                                                                                                                 |
| Comparison, N options × M criteria, cells are prose                                                                         | markdown table                                          | a diagram — unless the options differ in structure, then the "Everything else" row                                      |
| Quantitative, ≥5 data points                                                                                                | inline SVG chart (discipline below)                     | mermaid, chart libraries                                                                                                |
| Ordered message exchange, ≥3 participants                                                                                   | mermaid `sequenceDiagram`                               | hand-drawn — sole exception: avoiding the mermaid runtime (see figure budget)                                           |
| State machine >5 states with guards/terminals                                                                               | mermaid `stateDiagram-v2`                               | —                                                                                                                       |
| Everything else — structural, behavioral, data, deployment, or a structural comparison; loop-backs and hierarchies included | `diagram` skill, type per its `references/selection.md` | mermaid (auto-layout destroys boundary semantics), box kits (no backward edge), a table (flattens the structural point) |

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
    Variants `.hot` (blue) / `.gold` (amber) for emphasis. Draw each glyph as a simple
    inline 24×24 SVG outline icon (stroke `#9aa0aa`, or `#79a8e7`/`#f5a742` on
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
    runtime is auto-inlined, themed to the house palette; costs ~3.4 MB of the
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
  — severity variants `.callout.warn` (amber), `.callout.alarm` (red),
  `.callout.ok` (green), `.callout.note` (muted grey). Pick by consequence, not
  by mood: `warn` for a cost or a constraint, `alarm` for something that breaks
  or exposes if ignored, `ok` for a confirmed-good result, plain for a neutral
  aside. Severity rides the rail and the bold label only — body text stays ink
  in both themes, and every pairing is contrast-checked at 4.5:1.
- **Metadata rows**: `<div class="chips"><span class="chip"><strong>Status</strong> live</span>…</div>`
- **Pipeline/stage boxes** (when mermaid is overkill):
  `<div class="flow"><div class="frow"><div class="fbox gate"><span class="t">stage</span><span class="d">detail</span></div>…</div><div class="arrow">▼</div>…</div>`
  — `.fbox` variants: `.gate` (amber), `.ok` (blue), `.deny` (red).
- **Facts with columns**: markdown tables (themed automatically).

All of these work inside markdown files — markdown passes raw HTML through. Raw
pages: full freedom, but reuse the house tokens above so pages feel like one
product.

### Decks — the slide grammar

One idea per slide: a slide carries a kicker, an
`h2`, and **one** of the shapes below. If it needs two, it is two slides.

**Title slide** — mono kicker, two-tone headline (first phrase ink, second
phrase accent via `.hi`), a one-sentence thesis, then the stat row:

```html
<div class="cover">
<div class="kicker">series — subject</div>
<h1>First phrase. <span class="hi">Second phrase.</span></h1>
<p class="thesis">One sentence stating the claim the deck defends.</p>
<div class="stats">
  <div class="stat hot"><div class="num">4</div><div class="lbl">what it counts</div></div>
  <div class="stat"><div class="num">2</div><div class="lbl">what it counts</div></div>
</div>
</div>
```

At most 4 numerals, each with a mono label; a numeral is a fact the thesis rests
on, never decoration — more than four is a table. `.stat.hot` paints one numeral
accent; use it on at most one. `.cover` opens the deck and optionally closes it
as a restatement. Never a middle slide. Pass `--title` rather than opening the
file with a doc-style `# Title`: the heading is not consumed, so it stacks a
second headline above the cover's own `h1`.

**Content slides** — route by what the idea IS, under slide-specific caps:

| The idea is                          | Shape              | Cap       |
| ------------------------------------ | ------------------ | --------- |
| Peers with no edges between them     | `.cards.cols-3/-4` | 4 columns |
| Rows that each carry a state or time | `.rails`           | 6 rows    |
| Anything with real edges             | `.figure`          | 1 / slide |
| Lookup across N options × M criteria | markdown table     | —         |
| A single decision or warning         | `.callout`         | —         |
| Metadata about the slide's subject   | `.chips`           | —         |

**Column cards** — 2–4 peers, each with a mono eyebrow label, a heading, and a
tight body. `.cols-3`/`.cols-4` collapse to two columns under 62rem, one
under 40rem:

```html
<div class="cards cols-3">
  <div class="card">
    <span class="eyebrow">label</span>
    <h3>Heading</h3>
    <p>Two lines at most. Four columns tightens the body automatically.</p>
  </div>
</div>
```

**Legend rails** — rows sharing a scale (now/next/later, owned/shared/external,
pass/warn/fail). The rail colour groups; the legend decodes it once, above the
list. `.when` right-aligns a mono marker:

```html
<div class="legend">
  <span class="key hot">now</span>
  <span class="key gold">next</span>
  <span class="key dim">later</span>
</div>

<ul class="rails">
  <li class="rail hot"><strong>Row heading</strong> — supporting clause<span class="when">state</span></li>
  <li class="rail gold"><strong>Row heading</strong> — supporting clause<span class="when">state</span></li>
  <li class="rail dim"><strong>Row heading</strong> — supporting clause<span class="when">state</span></li>
</ul>
```

Rail variants: `.hot` (blue), `.gold` (amber), `.dim` (grey), `.red`. Use two or
three in one list — a rail per row with a unique colour groups nothing.

**Colour is structural, not typographic.** The rail, the swatch, and the node
border carry colour; row text stays ink/muted in both themes. Light-mode amber
clears 4.5:1 on `--navy` and the white `--card` but misses it on the
`--navy-deep`, `--accent-soft` and `--code-bg` grounds (4.26:1 / 4.07:1 /
4.29:1), so it is a rail colour only, never body text.

Every doc component above works inside a slide. Heavy diagrams get their own
slide with nothing but a kicker and an `h2` above them.

## Requirements and behavior

- Device token: `~/.config/agentkit/pages-token`. First use starts the bounded device flow at
  `pages.agentkit.sbs/device`, signs in through Assay, and stores the token with mode `0600`.
- Themes are bundled with the skill; if a clone of `gitlab.com/agentkit/agentkit-pages`
  exists at `~/code/agentkit-pages` (override: `AGENTKIT_PAGES_REPO`), the publish
  archives `src/` + `dist/` there only with explicit `--git` — otherwise it
  serves only. Repository archival has its own visibility and is never implied
  by a private page. Endpoint override: `AGENTKIT_PAGES_ENDPOINT`.
- New pages are **private by default**. Owners manage revocable sharing links and
  verified-email invites, and revoke publishing devices at
  `https://pages.agentkit.sbs/dashboard`. Pages from
  before the accounts migration remain public until claimed or removed.
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
- Publish refuses a baked (excalidraw) SVG that is not inside a `.figure`
  island or a container styled with `var(--diagram-bg)` — a dark-palette
  diagram on a page-supplied light background is illegible in both themes.
  `--allow-bare-svg` overrides when a raw page really owns its background —
  the pages-police hook blocks that flag unless the user approved it
  (`AGENTKIT_ALLOW_BARE_SVG=1`), and blocks raw API writes outright.
