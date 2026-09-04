---
name: diagram
description: Craft high-quality hand-drawn-style diagrams (Excalidraw JSON rendered to self-contained SVG). Use AUTOMATICALLY when the user asks to visualize, draw, diagram, or sketch anything — system architectures, workflows, protocols, timelines, comparisons, mental models — or when a task needs a visual that outclasses mermaid/box kits. Renders headlessly at generation time; output embeds anywhere HTML or markdown does.
---

# diagram

Turn concepts into diagrams that **make an argument**. The structure must carry
the meaning: cover the labels and the shape should still tell the story. If a
diagram is five identical boxes with different names, it has said nothing.

Method inspired by coleam00/excalidraw-diagram-skill; text and tooling here are
original.

## 1 — Classify, then decide the depth

**Open `references/selection.md` and copy the notation recipe for the type you
land on.** It defines the three axes, crosses altitude against relationship
into the named type, and holds the recipes — crow's-foot cardinality, C4
boundary semantics, trust zones — that make the figure correct rather than
merely tidy. Write the classification line first:

`altitude / relationship / audience → type`

Generic boxes-and-arrows is what comes out when this step was skipped, and a
figure that mixes two altitudes is misclassified rather than thorough.

The type also picks the register. **ERD, C4 context, C4 container and
deployment topology** route to the technical register below — and one narrowing
of deployment topology goes on to the stencil register after it; every other
type stays in the sketch register this file describes, where a correct glyph
teaches more than any icon. Then set the depth, which the audience term drives:

- **Conceptual**: mental models, philosophies, quick overviews. Abstract shapes
  and relationships are enough.
- **Technical**: real systems, protocols, integrations. You MUST research the
  real thing first — actual endpoint names, event names, payload shapes, config
  keys — and show **concrete evidence inside the diagram**: a real (sanitized)
  payload snippet, the true API call, a mini mockup of the actual output.
  Placeholder labels like "API" or "Event 1" are a failure; write
  `PUT /api/pages/:slug` and `RUN_STARTED`, not "endpoint" and "event".

### The technical register

Those four types render D2 to a self-contained SVG instead of hand-written
Excalidraw:

```bash
bun <skill-dir>/scripts/d2-render.ts --in topology.d2 --out topology.svg \
  --png topology.png --label "Production deployment topology"
```

**Orientation is not yours to guess.** A source that sets no board-level
`direction` is rendered both ways and the wrapper keeps whichever proportion
the page column can hold, printing the two it compared:
`orientation: down (362x1303) beat right (1880x234)`. Write `direction:` in the
source, or pass `--direction right|down`, when you want to pick it yourself; a
direction the source sets is never overridden.

**Before writing a line of that D2, ask whether the project can produce it.**
When the classification lands on a technical type and the system's shape is
already recorded somewhere — a module graph, a live schema, a state file, a
manifest directory — an extractor derives the D2 and you never author the
graph at all:

```bash
depcruise --no-config --output-type json 'src/**/*.ts' \
  | bun <skill-dir>/scripts/extract.ts deps --focus src --out modules.d2
```

`extract.ts deps | schema | infra | k8s` covers C4 component, ERD and
deployment topology; `references/selection.md` names the extractor beside each
type it serves. Choosing the scope is your job and the graph is never your
invention — which is the whole difference between a diagram that documents the
system and one that documents your memory of it. Reach for hand-written D2 only
when no such source exists, and see `references/technical-register.md` for what
these tools genuinely cannot know.

Renderer is pinned to **d2 v0.8.2**; the wrapper refuses any other version,
inlines vendored CC0 icons (`icon: @postgres`), and fails the render if the
output is not self-contained. The render-LOOK-fix discipline of step 5 applies
unchanged — read the PNG, never the SVG. Full-colour vendor logos are never
recoloured or theme-filtered; that is why D2 output is exempt from the page's
light-mode inversion.

**Never guess an icon name, and never paint a plate behind a mark.** Search the
manifest — it reports the licence and whether a hit is brand artwork or a
single-colour mark, and monochrome marks are re-inked to follow the page theme
automatically:

```bash
bun <skill-dir>/scripts/find-icon.ts traefik
```

A hardcoded `style.fill` behind an icon cannot follow the theme, so it leaves a
white box in dark mode. If the search finds nothing, the mark is not vendored —
say so rather than substituting another vendor's look-alike.

Azure and GCP icons are vendor-licensed, so none are committed. Fetch a pack
once, on the machine that needs it, then use `@azure:…` / `@gcp:…` like any
other icon:

```bash
bun <skill-dir>/scripts/fetch-icons.ts azure --accept-terms
```

The fetch is opt-in — no install step runs it — and prints the vendor's terms
unless `--accept-terms` is given. Referencing an unfetched pack fails the render
naming this command. See `references/VENDOR-LICENSES.md`.

### The stencil register

One narrowing of deployment topology leaves D2: a figure whose argument is the
reader recognising a **vendor's own mark** — an AWS ALB, an Azure Front Door, a
Cisco switch — where no extractor covers the source and the CC0 packs do not
carry the mark. That renders `.drawio` through draw.io Desktop:

```bash
bun <skill-dir>/scripts/drawio-render.ts --in topology.drawio --out topology.svg \
  --png topology.png --label "Cloud topology — ALB to EKS to RDS"
```

Pinned to **draw.io Desktop v31.3.2**; the wrapper refuses any other version,
screens the source for label styles that would export as `<foreignObject>`,
which the technical register already refuses, and fails the render if the output
is not self-contained — the same gate D2 output passes. draw.io is **shelled out to,
never vendored**: its stencil licence exempts exported diagram output but grants
no redistribution, so no draw.io artwork is committed here.

It is the last resort of the three, not the first. `references/selection.md`
holds the three questions that route a topology to it, and
`references/stencil-register.md` holds the install recipe, how to find a style
string, and the authoring rules.

Steps 2–6 below are the sketch register's. A technical figure leaves here and
follows `references/technical-register.md` end to end — authoring rules,
notation conventions, the icon manifest, the trademark rule and how the SVG is
inlined into a page. A stencil figure follows
`references/stencil-register.md` the same way.

## 2 — Map each concept to a structural pattern

The type from step 1 fixes the notation; this table picks the shape for each
concept drawn inside it. Pick the shape that behaves like the concept. In one
diagram, no two major concepts should reuse the same pattern.

| Concept behaves like…       | Draw it as…                                                |
| --------------------------- | ---------------------------------------------------------- |
| one source feeding many     | fan-out: center node, radiating arrows                     |
| many inputs producing one   | merge: arrows converging into a single node                |
| containment / hierarchy     | tree: trunk lines + free-floating labels, no boxes         |
| ordered steps in time       | timeline: one line, dots, labels above/below               |
| repetition that improves    | cycle: loop of arrows returning to start                   |
| input transformed to output | pipeline: before → machine → after, visibly different ends |
| two options weighed         | side-by-side halves with mirrored structure                |
| phases with a hard boundary | zones separated by whitespace or a divider line            |
| fuzzy context or state      | overlapping ellipses (cloud), no hard border               |

**Boxes are earned, not default.** Free-floating text with size/weight
hierarchy beats a box unless the element is a focal point, an arrow target, or
a true container.

**The table is a floor, not a ceiling.** For the concept that matters most,
invent the visual metaphor that IS that concept: a review gate drawn as an
actual gate across the flow; backpressure as a pipe narrowing; a cache as a
shadow copy sitting between planes; fan-out that visibly loses order.
Two tests before you keep a metaphor: strip the labels — does the structure
still say it? and would a newcomer _learn_ the mechanism from the picture
alone? If either fails, the metaphor is decoration; redesign it.

## 3 — Compose at three zoom levels (large diagrams)

1. a one-line overview strip (the whole story at a glance),
2. labeled zones grouping related parts,
3. teaching detail inside zones — the evidence artifacts.

Trace the eye-path before writing any JSON: where does the viewer start, what
do they follow, where do they end.

## 4 — Write the Excalidraw JSON section by section

Hand-write `.excalidraw` JSON — never generate the whole file in one pass (a
comprehensive diagram exceeds a single response's output budget and truncates):

1. Start the file with the wrapper (`type`, `version`, `appState`, `files`) and
   the first zone's elements.
2. Add ONE zone per edit, deliberately: layout, spacing, connections to what
   exists.
3. Use descriptive ids (`worker_rect`, `arrow_put`) and namespace `seed` per
   zone (100x, 200x…). When a new arrow binds to an earlier element, update
   that element's `boundElements` in the same edit.
4. After the last zone: re-read the whole file — bindings valid both ends,
   spacing balanced, every referenced id exists.

Palette: match the destination. For AgentKit Pages author the **dark house
palette only** — the page derives the light-theme rendering itself
(invert + hue-rotate on `svg[role="img"]`), so there is still exactly one
variant to produce and it must be the dark one: strokes `#eeeeee`, muted
`#9aa0aa`, accents `#79a8e7` (blue) / `#f5a742` (amber), fills transparent
or `#1b1d22`, background transparent. For READMEs/light surfaces:
near-black strokes with classic pastel fills (`#a5d8ff`, `#b2f2bb`, `#ffec99`).

The ink above is baked into the export either way — there is no page-driven
theme switch on this side of the register. A host that toggles its own theme
(not Pages, which supplies the island) needs a real ground under a baked
palette or the wrong-theme case shows bare strokes on a page of the opposite
color. Set the scene's `appState.viewBackgroundColor` (or pass `render.ts
--background`) to the palette's own surface color; leave it `transparent`
only when the destination is known to supply one, the way Pages does.

Contrast rules — the governing worst case is the DERIVED light rendering
(the filter darkens every color; the palette above was tuned so ink, muted
and both accents stay ≥4.5:1 there — an off-palette color has no such
guarantee, so check both renderings before keeping one):

- Red `#e06c75` is a stroke color, not a text color — its derived light form
  lands near 3.1:1, the graphics floor. Use it at strokeWidth ≥2 on
  shapes/arrows, never for text.
- Decoration never shares the hue of the text it decorates: underlines and
  strikethroughs under colored text use muted `#9aa0aa` or are dropped — amber
  under amber reads as a smear. Prefer size and weight over decoration.
- Text on a filled panel takes the neutral ink `#eeeeee`, never the fill's own
  color family; reserve the accent for a single data value.
- Two semantic colors adjacent at the same size need a legend (≥14 px), placed
  inside the zone it explains.

### Auto-layout (opt-in)

Hand placement stays the default. When the figure really is a graph, though —
nodes, edges, at most three zones, no invented metaphor — write the spec and let
dagre compute every coordinate.

**Open `references/auto-layout.md` before writing one.** It is the only complete
field list: every `role`, `shape` and flag, which characters each font carries,
the width each rank costs, what the layout guarantees and what it refuses. The
grammar below is the shape, not the vocabulary.

```yaml
title: How a signed request becomes an answer # optional
direction: down # right | down | auto (default auto)
palette: dark # dark | light       (default dark)
roughness: 1 # 0 crisp | 1 sketch (default 1)
background: "#ffffff" # optional backdrop; omit for transparent
zones:
  - { id: core, label: Core } # at most 3
nodes:
  - id: verify # at most 12
    label: signature valid?
    note: one line of detail under the label # optional
    role: decision # neutral start success decision agent inactive error evidence
    shape: diamond # rect | ellipse | diamond
    zone: core # optional; must name a declared zone
    mono: true # label in the mono font, for evidence artifacts
edges:
  - { from: gateway, to: verify, label: mTLS, dashed: false, role: error }
notes:
  - a muted line stacked under the figure
```

```bash
bun <skill-dir>/scripts/layout.ts --in figure.diagram.yaml --out figure.excalidraw
bun <skill-dir>/render.ts --in figure.excalidraw --out figure.svg --png figure.png \
  --label "Ingest pipeline, source to warehouse"
```

The layout measures each label against the font the renderer actually embeds,
sizes each box to its own text, draws the zone frames, routes the arrows and
binds them at both ends. It refuses rather than draws when it cannot be right: a
broken density budget, a self-edge, a character no embedded font carries, a spec
key it does not recognise.

**Left to right fits four ranks, not five.** Each rank costs its own box width
plus 92 px of gap, so a chain of minimum-width boxes warns at five ranks and is
refused at six; boxes carrying a note warn at four and are refused at five.
Leave `direction` unset and the layout runs both ways and keeps the one the
page column holds, restacking the chain for you and saying so;
`direction: down` names that restack by hand, and vertical space is free.
`examples/sketch-pipeline.diagram.yaml` is a worked spec that had to do exactly
that.

Step 5 still applies. Auto-layout removes the placement round, not the judgement
about whether the figure argues anything.

## Size & density budget

- **Canvas ≤ 1000 × 1400 px** for a page figure, **1000 × 620** for a deck
  slide — the page column renders figures at ~979 px, so authoring at display
  size means the diagram never scales below ~0.98. Hard ceiling 1200 px wide,
  and only with every font raised proportionally (≥18 px — at 1200→979 px the
  scale is 0.816, so 18 px lands at 14.7 px) so nothing falls below the 14 px
  floor after scaling.
- **Font floors**: annotations/legends 14 px, evidence/mono artifacts 13 px,
  labels 16–18, zone titles 20–24, hero title 28–32. Nothing below 13 px.
- **Density**: at most 3 zones, ~12 labeled nodes, ~25 text elements per
  diagram. Exceeding any of the three means **split, don't shrink** — one
  argument per figure; a fourth zone is a second figure with its own caption.
- **Fit to the screen, not to the canvas.** A published figure is read fitted
  into the column (~979 px) _and_ into ~60 % of the viewport height (540 px at
  1280 × 900). A per-figure toolbar zooms it and opens it full size, but that is
  the reader's choice, never the author's plan: the fitted read is the one that
  has to work. The height cap binds on any canvas taller than ~0.55 × its width,
  and it binds hard — 1000 × 1400 lands at 386 × 540, a 0.39 scale that puts a
  14 px label at 5.4 px. Author at or below ~1000 × 550 and only the width cap
  ever applies. Go taller and the render must be judged at its fitted size:
  split the figure if a label does not survive it.
- Vertical space was free while nothing capped height. Under the 60 vh fit it is
  the scarcer axis: when a layout is tight, drop a zone or split the figure
  rather than restacking taller.

## 5 — Render, LOOK, fix (mandatory loop)

JSON cannot be judged as JSON. Render, view the PNG with the Read tool, fix,
repeat — expect 2–4 rounds; one pass is never the final pass.

```bash
bun <skill-dir>/render.ts --in diagram.excalidraw --out diagram.svg --png diagram.png \
  --label "Ingest pipeline, source to warehouse"
```

Each round, in order:

1. **Vision audit first** — compare against the plan from steps 1–3, before
   hunting bugs: does the visual structure mirror the concepts? does each zone
   use its intended pattern? does the eye travel the path you designed? do
   hero elements dominate? are evidence artifacts readable where they belong?
2. **Defect sweep** — clipped or overflowing text; unintended overlaps; arrows
   cutting through shapes or landing in empty space; labels that don't clearly
   belong to anything; ragged spacing between siblings; one zone cramped while
   another floats in emptiness; text too small at render size; a lopsided
   whole.
3. **Page-scale pass** — view the PNG downscaled to the size the page reader
   actually gets: ~979 px wide, and no more than 540 px tall, whichever cap
   binds first. Confirm every label is still readable there; judge the diagram
   at reading size, not authoring size.
4. **Fix in JSON** — widen containers for clipped text; shift `x`/`y` for
   spacing; add waypoints to arrow `points` to route around shapes; pull
   labels next to their subjects; resize to rebalance visual weight.

**Stop only when** the render matches the planned design, nothing is clipped
or ambiguous, arrows land exactly, spacing is deliberate — and you would show
it to a staff engineer without a single caveat. "No critical bugs" is not the
bar; "couldn't be composed better" is.

(One-time setup: `cd <skill-dir> && bun install && bun run build`; rendering
needs a local Chromium — set `AGENTKIT_CHROMIUM` if it isn't auto-found.)

## Quality gate — every diagram answers yes to all of these

- **Depth**: researched real names/formats? evidence artifacts present
  (technical)? multi-zoom present (large)? teaches something concrete?
- **Type**: classification line written? notation of that type correct —
  cardinality glyph at the end touching its entity, boundaries drawn by trust
  not by team, exactly one altitude in the figure?
- **Concept**: structure would still communicate with labels removed? shows
  what prose could not? every major concept a different pattern? no uniform
  card grid anywhere?
- **Containers**: under ~30% of text boxed? trees/timelines built from lines +
  text? size/weight/color doing the hierarchy work?
- **Structure**: every relationship drawn? one clear eye-path? importance
  visible through scale and surrounding space?
- **Render**: PNG inspected this round? zero clipping/overlap? arrows exact?
  spacing consistent? composition balanced?

## 6 — Ship the SVG

The SVG is fully self-contained (fonts embedded as data: URIs), and every
renderer already writes the house root: the natural integer `width` and
`height`, the `viewBox`, `role="img"`, the `aria-label` from `--label`, and
`style="max-width:100%;height:auto"`. **Leave that root alone.** Never
replace the width with `width="100%"` — it upscales any figure narrower
than the column, which is how a tall sketch balloons. The theme caps a wide
figure to the column and leaves a narrow one at its own size, and the
lightbox reads the `viewBox` to expand back to natural size.

Inline it directly into a page (when publishing via publish-page, wrap it in
`<div class="figure">` with a semantic `figcaption`), drop it into a repo's
docs, or attach the PNG where images are needed. Caption by content, never
by tool.
