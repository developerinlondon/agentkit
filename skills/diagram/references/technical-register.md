# Technical register — D2 authoring reference

The technical register renders engineering notations (deployment topology,
C4 context/container, ERD) from [D2](https://d2lang.com) source. It is the
counterpart to the hand-drawn sketch register: **engineering notation goes
here; concepts and arguments stay in Excalidraw.**

Renderer is pinned to **d2 v0.7.1** (MPL-2.0). The wrapper refuses any other
version — a render is only reproducible on the build it was authored against.

```bash
bun skills/diagram/scripts/d2-render.ts \
  --in topology.d2 --out topology.svg --png topology.png \
  --label "Production deployment topology"
```

| Flag                | Default  | Use                                                                    |
| ------------------- | -------- | ---------------------------------------------------------------------- |
| `--layout`          | `elk`    | `dagre` is faster but overlaps sibling containers                      |
| `--theme`           | `0`      | light palette; `303` is D2's C4 theme                                  |
| `--dark-theme`      | `200`    | dark palette; must stay set or the page theme has nothing to switch to |
| `--pad`             | `40`     | pixels around the diagram                                              |
| `--salt`            | —        | set per diagram when two SVGs share one HTML document                  |
| `--label`           | filename | becomes `aria-label`; match the figcaption                             |
| `--keep-background` | off      | keeps D2's own backdrop instead of the figure island's                 |

## Derive before you author

**Do not hand-write D2 for a system whose shape a tool can already read.** The
four notations below all have a deterministic extractor: it reads the project's
own artefacts and emits D2 for this register. Your job is choosing the scope —
which subtree, which schema, which namespace — never authoring the graph.

The difference is not effort, it is truth. A hand-authored ERD records what you
remembered about the schema; a derived one records the schema. The same holds
for a module graph, a state file and a manifest directory: every node, edge and
label below traces to a line in the source.

```bash
depcruise --no-config --output-type json 'src/**/*.ts' \
  | bun skills/diagram/scripts/extract.ts deps --focus src --out modules.d2
bun skills/diagram/scripts/d2-render.ts --in modules.d2 --out modules.svg --png modules.png
```

`extract.ts` reads `--in FILE` or stdin, writes `--out FILE` or stdout, and
never runs the upstream tool for you — so a captured JSON works as well as a
live one, and nothing here needs credentials.

| Extractor | Input                               | Produces            | Scope levers                              |
| --------- | ----------------------------------- | ------------------- | ----------------------------------------- |
| `deps`    | `depcruise --output-type json`      | C4 component        | `--focus`, `--group-depth`, `--externals` |
| `schema`  | `tbls out -t json <dsn>`            | ERD                 | `--tables`                                |
| `infra`   | `tofu show -json`                   | deployment topology | `--group-by type`, `--no-reduce`          |
| `k8s`     | manifests, or `kubectl get -o json` | deployment topology | `--namespace`, `--config`                 |

All four take `--title`, `--direction` and `--max-nodes`. None of the upstream
tools is bundled: install the one you need, or feed the extractor a JSON file
someone else captured.

### The density budget is enforced, not suggested

A derived graph does not know when to stop. Each extractor refuses to emit more
than **12 nodes** and names the lever that narrows the scope, because SKILL.md's
answer to a figure past its budget is _split, don't shrink_. Raising
`--max-nodes` is a deliberate act; reaching for it twice means the figure is
carrying two arguments.

Grouping fails the other way too, and just as quietly: `deps` at
`--group-depth 1` puts every module of a `src/`-rooted project into one box.
A single box with no edges argues nothing, so that is refused as well —
raise the depth, or `--focus` the subtree you meant to compare.

### What each one derives

- **`deps`** groups modules by directory at `--group-depth` (2 by default, the
  depth at which a `src/`-rooted project has components rather than one box)
  and aggregates the imports between groups, so the node count follows the
  altitude you asked for rather than the file count. A pair of groups importing
  each other is drawn bold: a layering cycle is the one thing a module graph
  exists to expose.
  Core modules and packages are dropped unless `--externals` asks for them, and
  each package is one node however many of its files were imported.
- **`schema`** turns tbls tables into `sql_table` shapes with the real column
  types and `PK`/`FK`/`UNQ` badges, and turns tbls relations into crow's-foot
  edges attached to the specific columns. Required versus optional comes from
  the foreign key's nullability, which is why the derived ERD is more accurate
  than the one you would have drawn.
- **`infra`** reads addresses, types, providers and `depends_on`; modules
  become nested containers and counted resources collapse to `×N`. State
  records every ancestor a resource waited on, so edges a longer path already
  implies are dropped — pass `--no-reduce` to see the raw dump. **No attribute
  value is ever read**: `tofu show -json` embeds secrets in plain text, and a
  diagram must not become a way to publish state.
- **`k8s`** reads YAML manifests, a Helm/kustomize render, or a live
  `kubectl get -o json`. Namespaces become the boundary; service selectors,
  ingress backends, volume claims and env references become the edges; the
  container image picks the icon. It needs no cluster, which is the point — a
  repository's `k8s/` directory is enough.

### What cannot be derived, and must not be faked

A manifest does not declare that one service calls another. `k8s` recovers that
edge only where an env value names a Service by a whole DNS label, and takes
the protocol from the value's URL scheme; a name buried inside a longer word is
not evidence and produces no edge. Everything else about runtime behaviour —
call order, retry paths, failure modes — is a **behavioral** row, belongs in
the sketch register, and no extractor will invent it.

## 1 — Render, LOOK, fix

Same mandatory loop as the sketch register, for the same reason: **an agent
cannot see an SVG.** `--png` writes a raster twin; open it with the Read tool,
find the defect, fix the source, re-render. Expect 2–4 rounds.

The PNG is a verification aid, never a shipped asset — it is rasterised on the
dark island with slack around the content, so a little extra background at the
edges is expected.

Sweep each round for: containers that overlap (a boundary that overlaps is a
boundary that does not hold), edges crossing a container they do not enter,
labels detached from their edge, and tables whose last row falls outside the
frame.

## 2 — Deployment topology

Boundaries are **trust and network boundaries**, never decoration. One
container per zone that a packet must be authorised to cross.

```d2
vpc: Production VPC 10.0.0.0/16 {
  private: Private 10.0.10.0/24 — no inbound {
    api: api-server ×3 { icon: @logos:aws-ecs }
  }
}
client -> edge.cdn: HTTPS 443 { style.bold: true }
```

- Name the zone with its real CIDR/region and its rule (`no inbound`,
  `isolated`) — a box labelled "backend" teaches nothing.
- `style.stroke-dash: 4` marks a zone outside your control (public internet,
  a managed service, another team's account).
- **Every edge label carries intent and protocol**: `TLS 5432 read/write`,
  not `db`. An unlabelled edge is an unfinished edge.
- `direction: down` keeps a topology inside the page column; `right` produces
  a strip three times too wide to read.
- `near` pins a legend or an out-of-band actor: `near: top-center`.

## 3 — C4 context and container views

D2 ships a C4 theme (`--theme=303`). Model the level explicitly and do not mix
two levels in one figure.

- `shape: person` for actors, `style.multiple: true` when it is a role rather
  than an individual.
- One container per deployable unit; the technology belongs in the edge label
  or the icon, not invented into the node name.
- Edge labels take the C4 form `does what\n[technology]` — quote any label
  containing `\n` or brackets or D2 will not parse it.
- Externals (`identity provider`, `edge CDN`) sit outside the system container
  with `style.stroke-dash: 4`.

Level 1 (context) is the same file with the internals deleted — keep them as
separate sources rather than one file with layers, so each renders standalone.

## 4 — ERD

`shape: sql_table` gives real column rows; constraints drive the badges and
the crow's-foot arrowheads.

```d2
page: {
  shape: sql_table
  id: uuid {constraint: primary_key}
  site_id: uuid {constraint: foreign_key}
}
site.id -> page.site_id: contains\n1..N {
  source-arrowhead.shape: cf-one-required
  target-arrowhead.shape: cf-many-required
}
```

- Constraint keywords `primary_key`, `foreign_key`, `unique` render as
  `PK` / `FK` / `UNQ`. A join table takes both:
  `{constraint: [primary_key; foreign_key]}`.
- Cardinality is carried by the arrowheads, not by the label alone:
  `cf-one`, `cf-one-required`, `cf-many`, `cf-many-required`. Required vs
  optional is the difference between `NOT NULL` and nullable — get it right or
  do not draw it.
- Column **types must be the real ones** (`citext`, `timestamptz`,
  `bigserial`), because the diagram is read as a schema.
- Edges attach to the specific column (`site.id -> page.site_id`), never
  table-to-table.

## 5 — Icons

Reference a vendored icon with `@`; the wrapper expands it to a path and D2
inlines it as a `data:` URI:

```d2
db: Postgres 16 { icon: @postgres }
lb: Ingress    { icon: @logos:aws-vpc }
```

Bare names (`@redis`), set-qualified names (`@logos:redis`) and keyword
aliases (`@object storage`, `@service mesh`) all resolve through
`assets/iconify/manifest.json`. An unknown name fails the render rather than
leaving a hole. Where a name exists in both sets the full-colour `logos`
version wins; ask for `@simple-icons:<name>` to override.

Only CC0 packs are vendored (`logos`, `simple-icons`), under
`assets/iconify/` with their own NOTICE files — that artwork is **not** covered
by this repository's licence.

### Vendor packs (Azure, GCP) — fetched, never vendored

Cloud-vendor icon sets are vendor-licensed rather than CC0, so no vendor artwork
is committed. Fetch a pack once, on the machine that needs it:

```bash
bun skills/diagram/scripts/fetch-icons.ts azure --accept-terms
bun skills/diagram/scripts/fetch-icons.ts gcp   --accept-terms
```

Without `--accept-terms` the script prints the vendor's terms and downloads
nothing. Archives are fetched over https only, pinned by sha256; a vendor
re-release fails the fetch with the observed hash and re-pin instructions rather
than installing changed bytes. Before anything is unpacked the archive listing is
screened — an entry that is a symlink, escapes its root, or pushes the archive
past its size or entry ceiling disqualifies the whole pack. Each icon is then
screened against a normalized copy of itself (entity-decoded, lowercased,
whitespace-flattened), and a reference target passes only if it points inside the
icon (`#`) or carries its own bytes (`data:`) — everything else, however spelled,
disqualifies the pack. Nothing is wired into `install.sh` — fetching is always a
deliberate act.

Fetched icons then resolve exactly like vendored ones, under a pack prefix:

```d2
api: App Service   { icon: @azure:app-services/app-services }
db:  Cosmos DB     { icon: @azure:azure-cosmos-db }
bq:  BigQuery      { icon: @gcp:bigquery }
```

| Command                                        | Does                                      |
| ---------------------------------------------- | ----------------------------------------- |
| `fetch-icons.ts`                               | lists packs and whether each is installed |
| `fetch-icons.ts <pack> --list`                 | lists that pack's icon keys               |
| `fetch-icons.ts <pack> --list --filter sql`    | narrows the listing                       |
| `fetch-icons.ts <pack> --accept-terms --force` | refetches an installed pack               |

A name that exists twice with different artwork keeps the qualified form
(`@gcp:legacy/bigquery` beside `@gcp:bigquery`); the fetch reports every such
name. Referencing a pack that is not installed fails the render naming the fetch
command, the same way a missing `d2` binary does.

Trees land in `~/.agentkit/diagram/vendor-icons/` (override with
`AGENTKIT_DIAGRAM_VENDOR_ICONS`) — outside any repository, because they must
never be committed. Terms, pins and the reason AWS is excluded are in
[VENDOR-LICENSES.md](VENDOR-LICENSES.md).

### Trademark rule (hard)

**Vendor logos are never recoloured, distorted, or theme-filtered.** They are
reproduced unmodified for nominative identification only. This is why the
published SVG is exempt from the page's light-mode inversion filter, and why
any future palette or theming pass must exempt icon glyphs.

That applies to **full-colour brand artwork** — the `logos` pack. Nothing in the
pipeline touches those bytes.

A **monochrome** pack (`simple-icons`) is a different object: it ships one path
meant to be reproduced in whatever single colour its surround needs, and the
vendoring step bakes it to `#71717a` only because `currentColor` has nothing to
inherit from inside a `data:` URI. That one baked grey cannot work — no single
grey clears 3:1 against both the dark and the light node fill — so the renderer
**re-inlines monochrome marks as real `<svg>` elements** and lets the page theme
drive their ink. This is automatic:

```d2
edge: Traefik { icon: @traefikproxy }
```

**Never paint a plate to make a mark legible.** A plate is a fixed colour, so it
survives the theme flip and leaves a white box sitting in a dark page — the exact
defect the automatic path exists to prevent. If a mark looks wrong, check whether
it is monochrome first:

```bash
bun skills/diagram/scripts/find-icon.ts traefik
# @traefikproxy  simple-icons  CC0-1.0  monochrome (theme-inked automatically)
```

`find-icon.ts` searches the vendored manifest and reports the set, the licence
and whether a hit is brand artwork or a single-colour mark. Use it before
writing `icon:` — a name is not discoverable any other way, and a pack that
looks obvious may not carry the mark at all (the `logos` pack has 1861 icons and
no Traefik). When a mark is genuinely absent, say so; do not substitute a
look-alike from another vendor.

### Regenerating the vendored set

Edit `assets/iconify/icon-selection.json`, then:

```bash
cd /tmp && npm pack @iconify-json/logos@1.2.11 @iconify-json/simple-icons@1.2.92
for f in *.tgz; do tar xzf "$f" --one-top-level="${f%.tgz}"; done
bun skills/diagram/scripts/trim-iconify.ts --packs /tmp
```

The script refuses a pack whose version or licence does not match the pin, and
fails on any selected icon the pack does not contain. Commit the regenerated
tree together with the selection change.

## 6 — House integration

The published SVG carries `class="d2"`, `role="img"`, an `aria-label`, and a
`svg-source:d2` marker. Inline it in a `.figure` island exactly like a sketch:

```html
<div class="figure">
  <!-- svg-source:d2 --><svg class="d2" role="img" …>…</svg>
  <div class="figcaption">Production deployment topology</div>
</div>
```

Publishing outside a `.figure` island (or a container with
`background: var(--diagram-bg)`) is refused by the publish lint.

**Theme handling differs from the sketch register, deliberately.** A baked
Excalidraw SVG is authored dark and the page derives light mode by inverting
it. D2 emits _both_ palettes; the wrapper rewrites D2's
`prefers-color-scheme` guard to the page's own `html[data-theme]` attribute,
so the diagram follows the theme toggle rather than the operating system. The
theme therefore exempts `.d2` from the inversion filter:

```css
html[data-theme="light"] svg[role="img"]:not(.edges):not(.d2) { … }
```

Two consequences worth keeping straight:

- The inversion would recolour every embedded vendor logo, which the
  trademark rule forbids. The exemption is what makes icons legal here.
- Opened standalone (a README, a file:// tab) there is no `<html
  data-theme>` ancestor, so the guard cannot match and the **light** palette
  renders — the right default outside the page.

D2's own full-bleed background rect is removed so the island's surface shows
through. Pass `--keep-background` only when the SVG must stand alone on an
unknown surface.

## 7 — What the wrapper refuses

Each of these fails the render loudly rather than shipping a broken figure:

- a `d2` binary that is absent or not v0.7.1
- any `http(s)` reference that is not an XML namespace
- `<script>` or `<foreignObject>` — **`|md|` markdown blocks emit
  `foreignObject`**, so use `shape: text` for titles and prose
- an `href` left as a file path instead of an inlined `data:` URI
- fewer embedded icons than the source referenced
- an unknown `@icon` name
