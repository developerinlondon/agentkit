# Stencil register — draw.io authoring reference

The stencil register renders **vendor-stencil topologies** — the figure whose
argument depends on the reader recognising an AWS ALB, an Azure Front Door or a
Kubernetes Ingress by its published mark — from `.drawio` mxGraph XML.

It is the third register, and the narrowest. The [technical register](technical-register.md) still owns ERD, C4 context, C4 container and
deployment topology; the sketch register in `SKILL.md` still owns everything
else. draw.io is reached for **only** when vendor recognition is the point.

Renderer is pinned to **draw.io Desktop v31.3.2** (Apache-2.0). The wrapper
refuses any other version — a render is only reproducible on the build it was
authored against.

```bash
bun skills/diagram/scripts/drawio-render.ts \
  --in cloud-topology.drawio --out cloud-topology.svg --png cloud-topology.png \
  --label "Cloud topology — ALB to EKS to RDS"
```

| Flag           | Default    | Use                                                      |
| -------------- | ---------- | -------------------------------------------------------- |
| `--in`         | —          | the `.drawio` source, uncompressed XML                   |
| `--out`        | `<in>.svg` | the shipped SVG                                          |
| `--png`        | —          | raster twin at 2×, for the look-fix loop                 |
| `--label`      | filename   | becomes `aria-label`; match the figcaption               |
| `--border`     | `8`        | pixels around the diagram                                |
| `--page-index` | `1`        | which page of a multi-page file to export                |
| `--salt`       | filename   | id namespace; slugged either way, so `A b` becomes `a-b` |

## When draw.io, and when not

| The figure needs…                                                         | Register |
| ------------------------------------------------------------------------- | -------- |
| a vendor's own stencil, recognised on sight (AWS, Azure, GCP, Cisco, K8s) | draw.io  |
| a derived graph — module imports, a live schema, a state file             | D2       |
| C4 boundaries, crow's-foot cardinality, `PK`/`FK` badges                  | D2       |
| an argument carried by structure rather than by icons                     | sketch   |

**D2 is still the default for deployment topology.** It derives topologies from
`tofu show -json` and from a `k8s/` directory, and a derived figure beats an
authored one every time. draw.io earns the figure only when the vendor marks
themselves are load-bearing and no extractor covers the source — a
cloud-provider network diagram drawn for an audience that reads it by icon.

`selection.md` carries the routing rule; this file carries the mechanics.

## Licence — shell out, never vendor

Checked 2026-09-02:

- draw.io's core is **Apache-2.0**.
- `src/main/webapp/img/LICENSE` and `stencils/LICENSE` carry **only** an
  Atlassian-products restriction, and state: _"This restriction does not apply
  to end-user diagram output (such as exported images or documents) created
  using this software."_
- There is **no redistribution grant** for the stencils or images themselves.

So the rule is the same one PlantUML gets in these notes: **shell out to draw.io
to render; never copy its stencils, images or shape libraries into agentkit.**
The exported SVG is end-user diagram output and is explicitly exempt from the
restriction. A vendored stencil tree would not be.

This is why the register has no fetch step and no `assets/` tree of its own. The
artwork exists only inside the installed draw.io and inside the SVGs it exports.

## Install (headless Linux)

Nothing is wired into `install.sh` — like the vendor icon packs, installing is a
deliberate act on the machine that needs it.

```bash
mkdir -p ~/.agentkit/diagram/drawio && cd ~/.agentkit/diagram/drawio
curl -fsSLO https://github.com/jgraph/drawio-desktop/releases/download/v31.3.2/drawio-x86_64-31.3.2.AppImage
echo 'ca06cbe33876d22e92fc397d12bc164501016d18d200093690be3b312feec791  drawio-x86_64-31.3.2.AppImage' \
  | sha256sum -c -
chmod +x drawio-x86_64-31.3.2.AppImage
./drawio-x86_64-31.3.2.AppImage --appimage-extract   # 169 MB → 448 MB
rm drawio-x86_64-31.3.2.AppImage
```

The wrapper looks for `$AGENTKIT_DRAWIO`, then
`~/.agentkit/diagram/drawio/squashfs-root/drawio`, then `/opt/drawio/drawio`,
`/usr/bin/drawio`, `/usr/local/bin/drawio`, and the macOS app bundle.

Two things the wrapper handles that trip a first attempt:

- **A hung render is killed as a process group, not as a process.** `xvfb-run`
  is a shell script, so signalling it leaves the browser it wrapped running.
  The child is spawned detached and the timeout kills its whole group; if a
  descendant escapes into another session it keeps the inherited pipes open, so
  the timeout settles the call itself rather than waiting on a stream nothing
  will close.
- **Electron initialises a display even for `--version`.** On Linux with no
  `DISPLAY` or `WAYLAND_DISPLAY` the wrapper runs the binary under `xvfb-run`,
  and says so if `xvfb-run` is missing (`apt install xvfb`).
- **The AppImage ships `chrome-sandbox` unprivileged**, and Electron aborts
  rather than run with a sandbox it cannot trust. The wrapper checks the
  helper's ownership and mode, and adds `--no-sandbox` only when it is not
  setuid root — a distro package installs it correctly and keeps the sandbox.

Extraction rather than a FUSE mount is deliberate. An AppImage mounts itself
through FUSE 2, and on Ubuntu 25.04 there is no `libfuse2` to install — the
package was renamed `libfuse2t64` and is not present by default, so the obvious
`apt install libfuse2` fails. `--appimage-extract` needs none of it.

## Finding a style string

A shape is a `style=` string, not an image reference. Never guess one — the
shipped webapp is the authority, and it is a single archive in the install:

```bash
ASAR=~/.agentkit/diagram/drawio/squashfs-root/resources/app.asar
grep -a -o 'resIcon=mxgraph\.aws4\.[a-z0-9_]*' "$ASAR" | sort -u | grep rds
grep -a -o 'mxgraph\.kubernetes\.icon[0-9]*;prIcon=[a-z0-9_]*' "$ASAR" | sort -u
grep -a -o 'shape=mxgraph\.aws4\.group;grIcon=mxgraph\.aws4\.group_[a-z0-9_]*' "$ASAR" | sort -u
```

Then pull the **whole** quoted style the library ships for that shape, so the
node carries the vendor's own fill and gradient rather than colours you invented:

```bash
python3 - "$ASAR" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read()
i = data.find(b'resIcon=mxgraph.aws4.rds;')
print(data[data.rfind(b'"', 0, i) + 1:data.find(b'"', i)].decode())
PY
```

`jgraph/drawio-mcp`'s tool server exposes the same index as a `search_shapes`
MCP tool over ~10,000 stencils. It is a nicer interface and Apache-2.0, but it
is an extra dependency for a lookup two greps already answer — and see below for
why the rest of that repo does not replace this wrapper.

## Authoring rules

Write the `.drawio` file as **uncompressed** mxGraph XML. The editor's default
is a deflated `<diagram>` body; the wrapper refuses one, because it cannot
screen styles it cannot read. In the editor: **File ▸ Properties ▸ Compressed
off**, or edit through **Extras ▸ Edit Diagram**.

Every page is checked, not only the first, and the refusal names the page —
`--page-index` can export a later one, so a file whose second page is compressed
would otherwise reach the renderer unscreened.

### Every label must be plain SVG text

**`html=1` is the defect that ruins this register.** draw.io exports an HTML
label as a `<foreignObject>` inside a `<switch>`, beside a rasterised PNG twin
and a link back to drawio.com reading "Text is not SVG - cannot display".

Measured on this register's own example, that costs:

|                        | `html=1`                                      | `html=0`, no wrap |
| ---------------------- | --------------------------------------------- | ----------------- |
| bytes                  | 193,635                                       | 26,924            |
| `<foreignObject>`      | 11                                            | 0                 |
| base64 PNG label twins | 11                                            | 0                 |
| real `<text>` labels   | 1                                             | 11                |
| external URLs          | `drawio.com/doc/faq/svg-export-text-problems` | none              |

The external link alone fails the containment gate, and the technical register
already refuses `<foreignObject>` outright — `|md|` blocks get the same
treatment there. Beyond the rule: which branch of the `<switch>` a reader gets
is the renderer's choice, and the raster branch is text that cannot be selected,
searched, or scaled. Chrome draws the `foreignObject` branch in an `<img>`;
that is not something to rely on, and it is not worth 7× the bytes either way.

Three style tokens reach the HTML renderer. The wrapper screens the **source**
for all three and names the offending cell, because the rendered SVG reports a
count and never which cell produced it:

| Token             | Write instead                  |
| ----------------- | ------------------------------ |
| `html=1`          | `html=0`                       |
| `whiteSpace=wrap` | drop it, and shorten the label |
| `overflow=fill`   | drop it                        |

A label that needed wrapping is a label that is too long for the figure.

### Notation

The deployment-topology rules in `selection.md` apply unchanged, and the
stencils do not excuse them:

- Group by **trust or network boundary**, and name each with its real CIDR and
  its rule — `Private subnet 10.20.10.0/24 — no inbound`, not "backend".
  `mxgraph.aws4.group` with `grIcon=…group_vpc` / `…group_security_group` gives
  the vendor's own boundary chrome; keep `grStroke=1` or the box has no border.
- **Every boundary crossing carries protocol and auth**: `TLS 5432, IAM auth`,
  not `db`. Set `verticalAlign=bottom` so the label sits above its line.
- The ingress path is one continuous `strokeWidth=3` spine; everything else is 2.
- Replicas are `×N` on one node, never N drawn copies.
- Route edges with explicit `<Array as="points">` waypoints rather than letting
  the router lay a label across a group title. The band between two sibling
  groups is where a crossing label belongs.

### Density

SKILL.md's budget holds: at most 3 zones, ~12 labelled nodes. Nested vendor
groups eat the budget fast — an AWS cloud around a VPC around a subnet is three
already, before a single node is drawn.

## Render, LOOK, fix

Same mandatory loop, same reason: **an agent cannot see an SVG.** `--png` writes
a 2× raster twin; open it with the Read tool, find the defect, fix the XML,
re-render. Expect 2–4 rounds — the committed example took three, and every round
found a label sitting on top of something.

Sweep each round for: an edge label crossing a group title, a node label
overlapping the group border below it, a stencil whose group box has no visible
stroke, and dead vertical space inside a group that has outgrown its contents.

## Theme handling — light only, on its own plate

**draw.io's dark theme remaps every authored colour, brand fills included.** On
this register's own example it turns the ALB's `#D05C17` into `#E07C41`, the
RDS tile's `#3334B9` into `#AFB0FF` and the Kubernetes `#2875E2` into `#5597F5`.
The trademark rule in `technical-register.md` — _vendor logos are never
recoloured, distorted, or theme-filtered_ — forbids exactly that.

So the figure is exported `--theme light`, always, and carries a full-bleed
white plate of its own rather than borrowing the island's surface, which is dark
on a dark page. It is a fixed-colour card in both themes: the brand marks are
exact, and nothing about the page can alter them.

Two consequences:

- The publish-page themes exempt `.drawio` from the light-mode inversion filter,
  beside `.d2`, for the same reason. A filtered figure would be a recoloured
  logo.
- The island lint (`svg-source:excalidraw|d2`) deliberately does **not** cover
  `svg-source:drawio`. Its error tells the author to supply
  `var(--diagram-bg)` so the figure stays legible — advice that is false for a
  figure carrying its own plate. Wrap the SVG in a `.figure` island anyway for
  the caption; nothing forces it.

## Reproducible bytes, non-colliding ids

draw.io salts its gradient ids with a fresh nanoid on every render and emits each
mxCell id verbatim, so a raw export ships `id="0"` and changes on every run. Both
matter for a figure meant to be inlined: a diff that churns cannot be reviewed,
and `0` collides with whatever else the page carries — including a second draw.io
figure, whose cells are numbered from 0 too.

The wrapper replaces the generated salt and namespaces every id with one derived
from the output filename, rewriting `url(#…)` and `href="#…"` alongside. So
`cloud-topology.svg` carries `cloud-topology-alb`, the same source always renders
to the same bytes, and two figures coexist on one page. An id shape the strip
does not recognise fails the render rather than shipping churn.

**If you touch that rewrite, mind the second spelling.** draw.io writes each
paint server twice — as `fill="url(#x)"` and again inside `style=` as
`url(&quot;#x&quot;)` — and CSS honours the style copy. Rewriting only the
attribute form leaves the shape unpainted with nothing else out of place, which
is a defect no assertion about text or containment catches. It shipped that way
once. `verifyReferences` now refuses any render whose `url(#…)` or `href="#…"`
does not resolve to an id the figure defines, which is the check that catches
it.

## What the wrapper refuses

Each of these fails the render loudly rather than shipping a broken figure:

- a draw.io binary that is absent or not v31.3.2
- any compressed `.drawio` page, whose styles cannot be screened
- `html=1`, `whiteSpace=wrap` or `overflow=fill` on any cell style
- any `http(s)` reference that is not an XML namespace — including the SVG 1.1
  DTD in draw.io's own DOCTYPE, which is stripped
- `<script>` or `<foreignObject>` in the output
- an `href` left as a file path instead of an inlined `data:` URI

The last four run through `verifySelfContained` from `d2-svg.ts` — one gate for
both registers, so a draw.io figure ships under exactly the containment rule a
D2 figure does.

## Why a wrapper and not `jgraph/drawio-mcp`

The official repo (Apache-2.0) bundles four things. None of them replaces this
wrapper, checked 2026-09-02:

| Component            | Headless SVG export?                                              |
| -------------------- | ----------------------------------------------------------------- |
| MCP App Server       | no — renders an interactive viewer in chat, not a file            |
| MCP Tool Server      | no — stdio only, and `open_drawio_xml` shells out to `xdg-open`   |
| Claude Code skill    | yes — by shelling out to the same desktop CLI this wrapper drives |
| Project Instructions | no — emits an `app.diagrams.net` URL                              |

Their skill is a thinner prompt layer over `drawio -x -f svg`. It is worth
reading, and its `search_shapes` tool is genuinely useful, but it does not carry
the version pin, the source screening, the plate, the id namespace or the
self-containment gate — which are the parts that decide whether the figure ships
self-contained, reproducible and legible on the page. So: wrapper here, and
borrow `search_shapes` if the two greps above ever stop being enough.

`jgraph/draw-image-export2` was evaluated and rejected: **it has no SVG output
format at all.** Its dispatcher branches on `png`/`jpg`/`pdf` and answers
`400 Unsupported Format!` for `svg`.

## Example

`examples/cloud-topology.drawio` → `examples/cloud-topology.svg`: a customer
reaching an EKS-hosted API through a public ALB, with the AWS and Kubernetes
marks doing the recognition work and every crossing labelled with its protocol.
