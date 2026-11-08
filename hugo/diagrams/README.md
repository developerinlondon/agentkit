# diagrams — figures as data for Hugo

Each figure is a YAML file in the site's `data/diagrams/`. At build time a shortcode turns
it into inline SVG, a "Text version" list, and an entry in `/architecture.json`. Nothing
renders in the browser: no Mermaid, no layout engine, no client-side font measurement. A
small script adds hover/focus highlighting and an enlarge view; the figure is complete
without it.

```text
data/diagrams/<name>.yaml ──build──> <figure class="dg">  inline SVG + <title>/<desc>
        │                                                 + caption + Text version
        └──────────────build──────> /architecture.json    every spec, with its pages
```

`exampleSite/` is a complete, dependency-free site using every feature below: a flow and a
sequence, built-in and project icons, and project tokens. Build it with
`hugo -s exampleSite` from this directory.

## Using it in a Hugo site

1. Import the module before the theme (the first import wins, and this module must win the
   Mermaid render hook):

   ```yaml
   module:
     imports:
       - path: github.com/developerinlondon/agentkit/hugo/diagrams
       - path: github.com/imfing/hextra
   ```

   The first figure rendered publishes `/architecture.json`; no output format is needed.

   Pin a version with `hugo mod get github.com/developerinlondon/agentkit/hugo/diagrams@<ref>`.
   Module tags are `hugo/diagrams/vX.Y.Z`, cut alongside each agentkit release from the first
   release that contains this module; until one exists, pin a commit sha. Repository tags such
   as `v0.9.3` belong to agentkit itself and do not contain the module. To work without network
   access, copy this directory to `themes/diagrams/` and import `path: diagrams` instead.
2. Load the stylesheet, tokens and script on pages that use a diagram. With Hextra, create
   `layouts/_partials/custom/head-end.html` containing:

   ```go-html-template
   {{- partial "diagram/head.html" . -}}
   ```

   Any other theme: call the same partial inside `<head>`, and set `dark_selector` to how
   the theme marks dark mode (or `media` to follow the operating system).
3. Optional: point agents at `/architecture.json` from `llms.txt`. With Hextra, add `llms` to
   the home page's outputs (`outputs: {home: [html, rss, llms]}`), copy the theme's
   `layouts/llms.txt` into the site, and add `{{ partial "diagram/llms.html" . }}` above its
   closing `---` line. When a site publishes `llms.txt`, the check script requires the link.
4. Copy `scripts/check-diagrams.sh` into the site and run it in CI. It builds the site and
   fails on Mermaid, invalid or unused specs, layout warnings and nested `<svg>`.
5. Write `data/diagrams/<name>.yaml` and place it in a page with `{{< diagram "<name>" >}}`.

The module ships `_markup/render-codeblock-mermaid.html`, which fails the build on any
`` ```mermaid `` block, so Mermaid cannot come back by accident.

Requires Hugo 0.164 or later; the module is built and tested on 0.164 and 0.165. The standard edition is enough; nothing needs Hugo extended. The check
script needs `node` for its JSON checks.

## Site settings

```yaml
params:
  diagrams:
    content_width: 625 # px a figure gets in the text column (default 625)
    min_inline_px: 8 # smallest label allowed inline at that width (default 8)
    dark_selector: .dark # .dark, html.dark, [data-theme=dark], [data-bs-theme=dark] or media
    icons: # project icon packs: icon: "@acme/widget"
      acme: { path: icons/acme, mode: stroke } # files in assets/icons/acme/*.svg
    tokens: # project brand; defaults are the house theme
      sans: [Inter, -apple-system, system-ui, sans-serif] # names only; the module quotes them
      mono: [JetBrains Mono, ui-monospace, monospace]
      radius: 3 # node corner radius, px
      group_radius: 5
      icon_stroke: 1.4 # px, for stroke icons
      light: { accent: "#0f6e7a", accent_soft: "#dbebee" }
      dark: { accent: "#5bd2e0", accent_soft: "#14313a" }
```

Colour tokens, each with a light and a dark value: `surface`, `sunk`, `ink`, `muted`,
`line`, `accent`, `accent_soft`, `gate`, `gate_soft`, `deny`, `allow`. Keep one accent: it
marks the system the figure is about and the data path through it. An unknown key, or a
value outside its grammar, fails the build: colours are `#hex`, `rgb()`, `rgba()`, `hsl()` or
`hsla()`; numbers are px; fonts are a list of names (letters in any script, digits, spaces, hyphens) that the
module quotes itself.

**Readability.** Inline, a figure shrinks to what its frame leaves of the column (the
column less 46.8 px of padding and border), so its smallest label (11 px monospace) shows at
`11 × (content_width − 46.8) / canvas width`. The build fails when that falls
below `min_inline_px`, and the message names the widest canvas allowed. Every figure has an
**Enlarge** control (and tap-to-enlarge on the canvas) that opens it at 1:1 in a
full-viewport dialog: pinch or scroll to pan, Esc, the Close button or a click outside to
leave, focus returned to the control. Reduced motion turns the opening fade off.

## Spec

Every spec has `title` and `description` (both required; they become `<title>`, `<desc>`
and the top of the text version) and an optional `caption`. `kind` is `flow` (default) or
`sequence`. Multi-line text: write `"\n"` in a string, or a YAML list. A YAML flow list
splits on commas, so quote any line that contains one.

### Flow

```yaml
title: The deployment path
description: Merging to main builds an image; a human bumps the version …
caption: The only manual link in the chain is the version bump.
grid: { col: 200, row: 90 } # px per grid unit; positions below are in these units
direction: LR # LR or TD: which elbow an unspecified edge prefers
defaults: { w: 150 } # minimum node width
groups:
  - { id: pod, label: One pod, style: dashed }
nodes:
  - {
      id: api,
      label: API,
      sublabel: chat · users · audit,
      kind: accent,
      group: pod,
      col: 1,
      row: 1,
    }
  - { id: db, label: Postgres, icon: postgresql, kind: fill, col: 2.5, row: 1 }
edges:
  - { from: api, to: db, style: data, label: writes }
notes:
  - { text: Each organisation gets its own pod., col: 0, row: 2.2 }
rules:
  - { from: [0, 3], to: [4, 3], dashed: true, faint: true }
```

| Field                        | Values                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| node `id`                    | unique across nodes and groups                                                                                      |
| node `col`, `row`            | the node's centre, in grid units; fractions allowed                                                                 |
| node `w`, `h`                | px; default fits the text (`w` at least `defaults.w`)                                                               |
| node `label`                 | title line(s); bold when the node also has `body` or `sublabel` (override with `bold`)                              |
| node `body`                  | sans-serif lines under the title                                                                                    |
| node `sublabel`              | small monospace lines, coloured by `kind`                                                                           |
| node `kind`                  | `box` (default), `fill`, `accent`, `gate`, `deny`, `allow`, `ghost`                                                 |
| node `shape`                 | `rect` (default), `diamond`, `pill`, `none`                                                                         |
| node `dashed`                | `true` draws a dashed outline (something proposed, not built)                                                       |
| node `icon`                  | a name or list of names: `user` (any built-in pack), `logos/postgresql` (one pack), `@acme/widget` (a project pack) |
| node `group`                 | a group id; the group's box is the union of its members plus `pad`                                                  |
| node `description`           | shown on hover/focus and in the text version                                                                        |
| group `style`                | `dashed` (default), `solid`, `tint`, `gate`; `faint: true` dims the outline                                         |
| group `label_align`          | `start` (default) or `middle`                                                                                       |
| group `col`, `row`, `w`, `h` | explicit box instead of the computed one                                                                            |
| edge `from`, `to`            | node or group ids; `from` may equal `to` with `exit`/`enter` on one side                                            |
| edge `style`                 | `sync` (default), `async` (dashed), `data` (accent), `gate`, `deny`, `allow`                                        |
| edge `arrow`                 | `end` (default), `both`, `none`                                                                                     |
| edge `exit`, `enter`         | `left`, `right`, `top`, `bottom`; `exit_at`/`enter_at` slide the point along that side in px                        |
| edge `mid`                   | grid coordinate of the elbow's middle leg                                                                           |
| edge `via`                   | list of `[col, row]` waypoints                                                                                      |
| edge `route`                 | `straight` for a direct, possibly diagonal line                                                                     |
| edge `label_at`              | `[col, row]` pins the label centre; otherwise it sits on the longest segment                                        |
| edge `label_side`            | `above`/`below` (horizontal), `right`/`left` (vertical), `on`                                                       |
| edge `label_segment`         | 1-based segment index to carry the label                                                                            |
| edge `label_dx`, `label_dy`  | px nudges                                                                                                           |
| note `style`                 | `muted` (default), `caps`, `accent`, `gate`, `deny`, `allow`, `ink`, `bold`                                         |
| note `anchor`                | `start` (default), `middle`, `end`; `group` makes the note count toward a group's box                               |

Without `exit`/`enter`, an edge is a straight line when the two boxes face each other with
centres within a quarter of the smaller box; otherwise an elbow in the diagram's direction.
Edges from one source to several targets therefore share a trunk.

### Sequence

```yaml
kind: sequence
actors:
  - { id: a, label: Your agent }
  - { id: b, label: The board }
messages:
  - { from: a, to: b, label: claim WM-9 }
  - { from: b, to: a, label: "parked in review", style: reply }
  - { note: only now is it done, over: b } # over: an id or a list of ids
  - alt:
      - { label: approved, messages: [...] }
      - { label: changes wanted, messages: [...] }
```

Message `style` is `sync` (default), `reply` (dashed), `data` or `gate`. Actor spacing is
computed from the longest label per span; break a long label with `"\n"` to keep the
figure narrow.

## What the build checks

The build fails on: a missing spec, missing `title`/`description`, duplicate ids, an edge or
message naming an unknown node, an icon no pack has (or one two packs share, unqualified), a
missing or nested-`<svg>` project icon, an unknown kind, shape, style, side or route, a node
without `col`/`row`, a figure whose smallest label would show below `min_inline_px`, a bad
token, and any `` ```mermaid `` block. Every spec is validated, including specs no page uses,
because `/architecture.json` reads them all.

It warns when a node with an explicit `w` is probably too narrow for its text, and when an
edge label is longer than the segment it sits on. Both are estimates (monospace at 0.61 em,
sans at 0.54 em); `scripts/check-diagrams.sh` treats them as failures. Check the result by
screenshot in both themes as well: the build cannot see overlaps.

## House style

1.2 px ink strokes, 3 px corner radius, bold 13 px sans titles over 11 px monospace detail,
filled triangular arrowheads, one accent for data and the system itself, amber for gates and
anything waiting on a person, red and green only for refused and allowed outcomes. Every
colour is a CSS custom property (`--dg-*`), set from the tokens above.

## Icons

| Pack           | Licence                         | Notes                                                                                                                                                                                                         |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heroicons`    | MIT, `LICENSES/heroicons.txt`   | outline glyphs for generic parts (user, server, database, mail…), drawn in the theme ink and stroke                                                                                                           |
| `simple-icons` | CC0-1.0, `LICENSES/CC0-1.0.txt` | single-colour brand marks, drawn in the theme ink                                                                                                                                                             |
| `logos`        | CC0-1.0, `LICENSES/CC0-1.0.txt` | full-colour brand artwork, never recoloured                                                                                                                                                                   |
| `@<pack>`      | the project's own               | `assets/<path>/<name>.svg`, well-formed XML with one `<svg>` root, parsed and rebuilt (see Preparing icons). `mode: stroke` or `mono` normalises to the theme, `color` (default) keeps the icon's own colours |

`simple-icons` and `logos` are generated from the agentkit `diagram` skill's vendored CC0
packs (`bun scripts/sync-hugo-diagram-icons.ts` in the agentkit repo), so a Hugo figure and a D2 render draw
the same marks. An icon name two packs share must be written `pack/name`.

## Preparing icons

A project icon is parsed and rebuilt, never copied. What survives: `g`, `path`, `circle`,
`ellipse`, `rect`, `line`, `polyline`, `polygon`, `defs`, `linearGradient`, `radialGradient`,
`stop`, `clipPath`, `mask`, `title` and `desc` (text only), with geometry and presentation
attributes, each value checked against its own grammar; `url(#id)` is the only URL. The
module does the harmless clean-up itself:

- a leading byte-order mark, the XML prolog, a doctype and comments are dropped;
- editor data is dropped: namespaced elements and attributes (`sodipodi:`, `inkscape:`,
  `figma:`, …), `xmlns`, `data-*` and `<metadata>`;
- a `style` attribute becomes the equivalent presentation attributes, through the same
  grammars; anything else in it is dropped;
- the root `<svg>`'s presentation attributes (`fill="none"`, `stroke="currentColor"`, …)
  carry over to the icon.

Figma, Lucide, Tabler and Inkscape exports build as they are. A `<style>` element, a
`class` attribute or `<use>` fails the build. Run the first two through svgo with the
module's config:

```sh
npx svgo@4.0.2 --config path/to/diagrams/svgo.config.mjs -i exported.svg -o assets/icons/<pack>/<name>.svg
```

svgo cannot inline `<use>`: unlink clones in the editor before exporting (Inkscape: Edit ›
Clone › Unlink Clone; Illustrator: Object › Expand).
