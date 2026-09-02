# Auto-layout for the sketch register

`scripts/layout.ts` turns a node/edge spec into placed Excalidraw JSON, which
`render.ts` then renders with no changes of its own. Layout runs in bun with no
browser and no network call.

## Spec fields

```yaml
title: How a signed request becomes an answer # optional, drawn top-left
direction: down # right | down       (default right)
palette: dark # dark | light       (default dark)
roughness: 1 # 0 crisp | 1 sketch (default 1)
background: "#ffffff" # optional backdrop rectangle; omit for transparent
zones:
  - { id: core, label: Core }
nodes:
  - id: verify
    label: signature valid?
    note: one line of detail under the label # optional
    role: decision # neutral start success decision agent inactive error evidence
    shape: diamond # rect | ellipse | diamond
    zone: core # optional; must name a declared zone
    mono: true # label in the mono font, for evidence artifacts
edges:
  - { from: verify, to: plan, label: "yes", dashed: false, role: error }
notes:
  - a muted line stacked under the figure
```

`role` picks the stroke and fill pair from the house palettes in
`elements.md`; nothing invents a colour. An edge inherits its source node's
role unless it names one. Every key is checked: an unknown key fails the run
rather than being ignored, because the usual cause is an unquoted comma
swallowing half a label.

## Which characters you can write

Boxes are sized from a measured table, so a character the table does not hold
cannot be sized for and is refused by name. The table is generated from the
woff2 faces the renderer embeds, and it keeps a glyph only when those faces
genuinely carry it: a glyph the font lacks falls through to whatever the
viewer's system supplies, at a width nothing here can predict.

What that leaves you:

- **Printable ASCII and Latin-1**, in both fonts. Accented letters are fine.
- **`x . - _ ... , en and em dashes`** and the other typographic marks in both.
- **Arrows and set notation are NOT in Excalifont.** `->` and `<-` in ASCII
  read fine in a sketch. The mono font does carry the real glyphs, so a label
  with `mono: true` may use them; a note or a caption may not.
- **No CJK.** The renderer declares no CJK fallback, so it would render
  differently for every reader.

The refusal names the character and says which font, if any, carries it.

## What it guarantees

- **Text fits.** Every label is measured against the font the renderer embeds,
  using `assets/font-metrics.json`. The table is exact, not an estimate:
  measured widths match the browser's `measureText` to the last decimal. Boxes
  grow with the line count, and the canvas is sized from every element drawn,
  so a caption wider than the graph still lands inside it.
- **Boxes do not collide.** Ranks and cross-axis separation come from dagre.
  Zone frames are padded for their own titles, and the run widens the ranks and
  retries if a padded frame still touches a node that is not its own.
- **Arrows land.** Endpoints come from dagre's polyline, trimmed back so the
  head sits off the stroke, with `startBinding` and `endBinding` set and both
  shapes listing the arrow in `boundElements`.
- **Reading order is yours.** Siblings appear in declaration order. dagre seeds
  its ordering pass backwards, so the graph is fed to it reversed.
- **The budget is enforced.** More than three zones, more than twelve nodes, or
  a canvas past 1200x1400 is refused with the reason. Past 1000 px wide it warns.
- **Renders are reproducible.** Seeds are derived from element ids, so the same
  spec produces byte-identical JSON every time.

## What it refuses

- A **self-edge**. A layered layout has no rank for one: dagre returns a
  polyline that lands nowhere near the node, bound at both ends to it. Draw the
  repetition as a cycle through a second node, or say it in the label.
- A **character no embedded font carries**, as above.
- A **spec key it does not recognise**, because the usual cause is an unquoted
  comma that swallowed half a label.
- A figure **past the density budget or the canvas ceiling**.

## What it cannot draw

A layered graph layout draws layered graphs. It will not produce a timeline, a
tree built from trunk lines and free-floating labels, overlapping ellipses for
fuzzy state, a pipe that narrows to show backpressure, or any of the invented
metaphors step 2 of `SKILL.md` asks for. Those stay hand-placed.

It also cannot wrap a long chain. Six ranks of ordinary boxes runs past 1600 px
left to right, so a deep flow has to be authored with `direction: down`. There
is no equivalent of the hand-placed trick of bending a row down into a second
row.

## Regenerating the font metrics

`assets/font-metrics.json` is measured from the woff2 faces the renderer
embeds, so it has to be regenerated when `@excalidraw/excalidraw` moves:

```bash
cd <skill-dir> && bun install && bun run build
bun scripts/layout/font-metrics.ts
```

The generator renders a probe string through the real pipeline, pulls the
embedded `@font-face` data URIs back out of the SVG, registers them in the
page and measures each character at 100 px. Family 2 is not measured; the
renderer serves it from system fonts and embeds nothing.

## Why dagre, and not the alternatives

Measured in this repo against bun 1.3.10 and `@excalidraw/excalidraw` 0.18.1.

| Option                                    | Licence                           | Runs in bun | Compound zones           | Verdict  |
| ----------------------------------------- | --------------------------------- | ----------- | ------------------------ | -------- |
| `@dagrejs/dagre` 3.1.1                    | MIT                               | yes         | yes, with edge polylines | adopted  |
| `elkjs` 0.12.0                            | EPL-2.0 OR GPL-3.0-or-later       | no          | yes                      | rejected |
| `@excalidraw/mermaid-to-excalidraw` 2.2.2 | MIT                               | needs a DOM | yes                      | rejected |
| `BV-Venky/excalidraw-architect-mcp`       | MIT over grandalf, GPLv2 or EPLv1 | Python      | parsed, then dropped     | rejected |

**elkjs** has the better edge routing and it is the option the issue named
first. It does not run under bun. Every entry point reaches the same fake-worker
fallback in `elk-api.js`, which resolves `Worker` to undefined and throws
`TypeError: undefined is not a constructor`; the documented `workerFactory`
escape hits it too, and importing `elk-worker.min.js` directly hangs on its
message loop. Running it inside the render page would work, at the cost of a
Chromium round trip for every layout. Its licence is also not on the allowlist.

**mermaid-to-excalidraw** produces good cluster-aware layout and genuinely
self-contained output, but it needs a real DOM, it constrains authoring to
mermaid's syntax, and it falls back to a rasterised image element without
raising when its mermaid version cannot parse a subgraph. A silent fall back to
a bitmap is the worst failure a sketch renderer can have.

**excalidraw-architect-mcp** emits valid Excalidraw JSON and ports roughjs
faithfully, but it embeds no font, so its text renders in whatever the viewer
has; it parses subgraphs and then discards them before layout; and its layout
library, grandalf, is offered under GPLv2 or EPLv1, neither of which this repo
can take.

Reopening this decision needs new evidence, not a rereading. The specific things
that would change it: elkjs running in bun without a worker shim, or a figure
whose routing dagre demonstrably cannot handle.
