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

## 1 — Decide the depth

- **Conceptual**: mental models, philosophies, quick overviews. Abstract shapes
  and relationships are enough.
- **Technical**: real systems, protocols, integrations. You MUST research the
  real thing first — actual endpoint names, event names, payload shapes, config
  keys — and show **concrete evidence inside the diagram**: a real (sanitized)
  payload snippet, the true API call, a mini mockup of the actual output.
  Placeholder labels like "API" or "Event 1" are a failure; write
  `PUT /api/pages/:slug` and `RUN_STARTED`, not "endpoint" and "event".

## 2 — Map each concept to a structural pattern

Pick the shape that behaves like the concept. In one diagram, no two major
concepts should reuse the same pattern.

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

Palette: match the destination. For AgentKit Pages (navy figures): strokes
`#dce7f5`, muted `#8fa8c7`, accents `#34d3a6` / `#e8b444`, fills transparent or
`#102847`, background transparent. For READMEs/light surfaces: near-black
strokes with classic pastel fills (`#a5d8ff`, `#b2f2bb`, `#ffec99`).

## 5 — Render, LOOK, fix (mandatory loop)

```bash
bun <skill-dir>/render.ts --in diagram.excalidraw --out diagram.svg --png diagram.png
```

Read the PNG. Judge it like a reviewer: overlaps, clipped text, cramped zones,
a missing visual story. Fix the JSON and re-render until it is genuinely good —
one render is never the final render. (One-time setup: `cd <skill-dir> && bun
install && bun run build`; rendering needs a local Chromium — set
`AGENTKIT_CHROMIUM` if it isn't auto-found.)

## 6 — Ship the SVG

The SVG is fully self-contained (fonts embedded as data: URIs). Inline it
directly into a page (wrap in `<div class="figure">` with a semantic
`figcaption` when publishing via publish-page), drop it into a repo's docs, or
attach the PNG where images are needed. Caption by content, never by tool.
