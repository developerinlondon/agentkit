# Excalidraw JSON authoring reference

File wrapper:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "agentkit-diagram",
  "elements": [],
  "appState": { "viewBackgroundColor": "transparent", "gridSize": 20 },
  "files": {}
}
```

## Fields every element needs

`id` (descriptive string), `type`, `x`, `y`, `width`, `height`, `angle: 0`,
`strokeColor`, `backgroundColor`, `fillStyle: "solid"`, `strokeWidth`,
`strokeStyle: "solid"`, `roughness`, `opacity: 100`, `seed` (namespace per
zone: 100x, 200x…), `version: 1`, `versionNonce` (any int), `isDeleted: false`,
`groupIds: []`, `frameId: null`, `boundElements: null`, `updated: 1`,
`link: null`, `locked: false`.

## Per-type additions

| Type        | Extra fields                                                                                                                                                                         | Notes                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `rectangle` | `roundness: {"type":3}` for rounded                                                                                                                                                  | processes, components, evidence panels                                |
| `ellipse`   | —                                                                                                                                                                                    | entry/exit, external systems; 10–20px dots = timeline markers/anchors |
| `diamond`   | —                                                                                                                                                                                    | decisions and conditions only                                         |
| `text`      | `text`, `originalText` (same words), `fontSize`, `fontFamily`, `textAlign`, `verticalAlign`, `containerId: null`, `autoResize: true`, `lineHeight: 1.25`                             | free-floating labels; `containerId` only when truly inside a shape    |
| `arrow`     | `points: [[0,0],[dx,dy]]`, `startBinding`/`endBinding` (`{"elementId":"id","focus":0,"gap":2}` or null), `startArrowhead: null`, `endArrowhead: "arrow"`, `lastCommittedPoint: null` | when bound, add this arrow's id to the target's `boundElements`       |
| `line`      | `points` like arrow, no arrowheads                                                                                                                                                   | tree trunks, dividers, structure                                      |

Fonts: `fontFamily: 1` = hand-drawn (headers, labels — the excalidraw feel),
`3` = monospace (evidence artifacts: payloads, endpoints, code). Sizes: titles
20–28, labels 16, evidence text 12–14.

## Look

- `roughness`: 0 = crisp/professional (default), 1 = sketch/brainstorm. Pick
  one per diagram, never mix.
- `strokeWidth`: 1 subtle lines/dividers, 2 shapes and normal arrows, 3 only
  for the single main flow. `opacity` always 100 — hierarchy comes from size,
  color, and whitespace, not transparency.
- Scale hierarchy: hero element ~300×150, primary ~180×90, secondary ~120×60,
  markers 12px. The most important element also gets the most empty space.
- If two elements are related, draw the connection — proximity alone reads as
  coincidence.

## Container/text pairing and arrows

- Text inside a shape is a two-way link: the text carries `containerId:
  "<shape-id>"` AND the shape carries `boundElements: [{"id": "<text-id>",
  "type": "text"}]`. One side alone breaks centering.
- Bound arrows likewise: the arrow holds `startBinding`/`endBinding` and each
  bound shape lists the arrow in its `boundElements`.
- Curved arrows: 3+ entries in `points`; waypoints are also how an arrow routes
  around shapes instead of through them.
- An arrow inherits the stroke color of its SOURCE's semantic role; arrows
  never introduce colors of their own.

## Semantic palettes (stroke / fill pairs — one role, one pair, always)

Navy pages (background transparent, sits on the `.figure` glow):

| Role                        | stroke           | fill                                                 |
| --------------------------- | ---------------- | ---------------------------------------------------- |
| default / neutral           | `#dce7f5`        | `transparent` or `#102847`                           |
| start / trigger             | `#e8b444`        | `#2a2410`                                            |
| end / success / active path | `#34d3a6`        | `#0d2f3a`                                            |
| decision (diamond)          | `#e8b444`        | `transparent`                                        |
| agent / AI                  | `#b197fc`        | `#1d1636`                                            |
| inactive / future           | `#8fa8c7` dashed | `transparent`                                        |
| error / removal             | `#e06c5f`        | `#2a1512`                                            |
| evidence panel              | `#1e3a5f`        | `#071224` (mono text `#34d3a6` data, `#dce7f5` code) |

Text hierarchy without boxes (navy): titles `#dce7f5` 20-28px, subtitles
`#34d3a6` 16px, detail/annotation `#8fa8c7` 14px (mono evidence may drop to
13px; nothing below 13px anywhere, legends included).

Light surfaces (READMEs, docs): near-black `#1e1e1e` strokes; fills `#a5d8ff`
(neutral), `#fed7aa` (start), `#b2f2bb` (success), `#ffec99` (decision),
`#ddd6fe` (agent/AI), `#ffc9c9` (error); inactive = dashed `#748ffc` on
transparent; evidence panels `#1e293b` fill with `#22c55e` data / `#e2e8f0`
code text. Text hierarchy: titles `#1e40af`, subtitles `#3b82f6`, detail
`#64748b`.

Rules: darker stroke over lighter fill, always; a concept without a role uses
neutral, never a fresh color. Red `#e06c5f` is a stroke/shape color — as text
only at 16px+. Text inside any filled panel uses the neutral ink, never the
fill's own color family. Underline/strikethrough decoration never shares the
hue of the text it decorates — use muted `#8fa8c7` or drop the decoration.
