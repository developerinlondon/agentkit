# Diagram selection — classify before you draw

State the classification in one line, then derive the type from the grid:

`altitude / relationship / audience → type`

**Altitude** — the zoom the question lives at. One altitude per figure; a
component sitting next to an external system is a misclassified diagram, not a
detailed one. Ladder: business capability → system context → container →
component → code/data.

**Relationship** — what the edges mean: structural (what contains or connects
to what), behavioral (what happens, in what order), data (what is stored and
how it relates), deployment (where it runs, inside which boundary), comparison
(options weighed), quantitative (magnitudes).

**Audience** — who reads it. It does not pick the column; it caps the row and
sets the depth. A non-engineering audience caps altitude at system context and
drops technology lines, protocol labels and evidence artifacts; an implementer
audience requires all three. When the cap and the question conflict, the cap
wins and the detail goes in the prose around the figure.

## The grid

| Altitude            | Structural                      | Behavioral               | Data               | Deployment          | Comparison           | Quantitative        |
| ------------------- | ------------------------------- | ------------------------ | ------------------ | ------------------- | -------------------- | ------------------- |
| business capability | capability map · value exchange | value stream             | domain model       | sourcing map        | mirrored streams     | funnel / trend      |
| system context      | C4 context                      | actor↔system flow        | interchange map    | trust-zone map      | before/after context | edge-rate annotated |
| container           | C4 container                    | sequence / state machine | data-ownership map | deployment topology | mirrored topologies  | hop budget          |
| component           | C4 component                    | control flow with gates  | read/write map     | process model       | mirrored halves      | hot-path breakdown  |
| code / data         | type relationships              | call trace / algorithm   | ERD (crow's foot)  | — go up one         | before/after shape   | distribution chart  |

## Triggers — what in a prompt or repo selects a row

| Type                | Trigger phrases and repo signals                                                          |
| ------------------- | ----------------------------------------------------------------------------------------- |
| capability map      | "what the business does", "capability model", "what's in scope for the platform"          |
| value exchange      | "our business model", "who pays us for what", "where the money flows"                     |
| value stream        | "end to end", "how does an order actually flow", "where does it get stuck"                |
| domain model        | "our core entities", "what is a Customer to us", glossary or ubiquitous-language doc      |
| sourcing map        | "build vs buy", "which vendor covers what", "who owns which capability"                   |
| C4 context          | "how does X fit with everything else", "who talks to this system", "the big picture"      |
| C4 container        | "architecture of this repo", "what are the moving parts", `docker-compose.yml`, `charts/` |
| C4 component        | "inside the worker", "how is this service structured", one crate/package with modules     |
| interchange map     | "what data crosses to the vendor", "PII flow", "what's in the payload between A and B"    |
| trust-zone map      | "attack surface", "what's exposed publicly", "security review of the topology"            |
| deployment topology | "how a request reaches X", "where does this run", `terraform/`, ingress/manifest files    |
| sequence            | "in what order", "the handshake", "who calls whom first", several participants exchanging |
| state machine       | "possible states", "when can it be cancelled", an enum + transition guards in code        |
| control flow        | "the retry path", "what happens on failure", a loop-back or gate in the logic             |
| ERD                 | "the schema", "data model", `migrations/`, `models.py`, `schema.prisma`, `CREATE TABLE`   |
| type relationships  | "class hierarchy", "how these types compose", trait/interface implementations             |
| mirrored comparison | "A vs B", "before and after the refactor", "which approach"                               |
| quantitative        | "how much", "trend", "breakdown", ≥5 numbers in the source                                |

**Tie-break — when two rows fire, the narrower signal wins, in this order:**

1. the prompt names a runtime substrate (k3s, a VPC, the edge, a device) →
   deployment topology, whatever else fired;
2. it names a schema artifact (`schema.prisma`, `migrations/`, `CREATE TABLE`)
   → ERD;
3. otherwise the question decides: "what are the moving parts" → the C4 row for
   that altitude, "where does it run / how does a request get there" →
   deployment topology.

`charts/` and `docker-compose.yml` are inventories of deployables, not
substrate — they select C4 container unless the prompt also says where it runs.
`terraform/` and ingress manifests are substrate and select deployment topology.

## Register

The type decides the register, and there are two.

The **technical register** — crisp strokes, D2 source, vendored vendor icon
stencils — carries exactly four types today: **ERD**, **C4 context**, **C4
container** and **deployment topology**. These are the rows whose correctness is
mechanical rather than compositional: real column types with `PK`/`FK`/`UNQ`
badges, crow's-foot arrowheads that encode required versus optional, CIDR-named
trust zones. When the classification lands on one of them, author D2 and follow
`technical-register.md`.

Every other row is drawn in the **sketch register** — the hand-drawn excalidraw
pipeline in `SKILL.md`. There, notation correctness beats icon fidelity: a
correct crow's foot or a correctly placed trust boundary teaches; a vendor logo
does not. C4 component, interchange map, trust-zone map and process model sit
here for now, and stay here until the technical register grows recipes for
them — do not reach for logo look-alikes to fake the register you are not in.

**Type is not medium.** For **sequence** and **state machine** the destination
picks the tool: publish-page's routing table owns those thresholds and sends
the large ones to mermaid on its runtime budget. The sketch recipes below apply
when it does not — a README, or a page already carrying inline SVG figures. No
threshold for them is restated here.

## Notation that must be right

### ERD — crow's foot

- Entity: sharp-cornered `rectangle` (no `roundness`), 200–260 wide. Name bound
  as centered text (16px, `fontFamily: 1`) with a `line` divider under it;
  attributes are ONE free-floating `text` element below (`fontFamily: 3`,
  13–14px, `textAlign: "left"`, `containerId: null`, one attribute per `\n`).
  Bound text centers — attribute rows must be left-aligned, so never bind them.
- Mark keys inline in the rows: `PK id`, `FK owner_id`, `* required`.
- Relationships are `line` elements, `endArrowhead: null`. Direction is not
  information in an ERD; an arrowhead here is a defect.
- **The cardinality glyph sits at the end of the line that touches the entity it
  describes** — this is the rule that gets inverted. Many = three ~12px `line`
  strokes fanning from the line's endpoint; one = a ~14px perpendicular tick;
  zero = an 8–10px `ellipse` on the line just outside the tick or fan. Combine
  per side, cardinality mark inboard and modality mark ~8px outboard of it:
  `||` two ticks (exactly one), `|O` tick then ellipse (zero or one, a nullable
  FK), `}|` fan then tick (one or many), `}O` fan then ellipse (zero or many).
- Verb at the line midpoint, 14px muted, reading with the line ("places", "owns").

### C4 — context, container, component

- **At most one boundary per figure**, dashed `rectangle` (`strokeStyle:
  "dashed"`, muted stroke, transparent fill), its label a free text at the
  top-left inside it. Context = people + the system + externals, no internals,
  and normally NO boundary box — draw an enterprise boundary only when internal
  versus external is itself the point. Container = one system boundary with
  deployables inside, people and externals outside. Component = one container
  boundary with modules inside, adjacent containers outside as muted stubs.
- Person: a ~20px `ellipse` head over a small rounded rectangle body, label
  beneath. External systems take the muted stroke; the system in focus takes
  the accent stroke, its fill, and the largest scale on the canvas.
- A container box carries three stacked lines: name (16px), `[technology]`
  (13px mono muted), one-line responsibility (14px muted). The missing
  technology line is the standard C4 failure.
- Every edge is labeled with intent plus protocol ("reads runs, HTTPS/JSON").
  An unlabeled edge in a C4 view is a defect.
- **Budget**: three lines per box plus a label per edge spends text elements
  fast, so cap a container view at **5 containers** — 15 box texts + 1 boundary
  label + 2 external labels + 6 edge labels = 24, inside SKILL.md's ~25. A sixth
  container means grouping into subsystems, not splitting into a second figure.

### Deployment topology

- Group by **trust or network boundary, never by team or layer**: one dashed
  zone rectangle each (public internet, edge, private cluster, operator device),
  labeled top-left, separated by whitespace. Nest at most three deep
  (zone > node > runtime).
- Node = solid rectangle with a small type band at its top-left corner ("k3s
  node", "R2 bucket", "browser"); software instances sit inside it.
- Every boundary crossing is labeled with protocol and auth ("HTTPS", "mTLS",
  "SSH key"). An unlabeled line crossing a zone edge defeats the diagram.
- The ingress path — outside actor through to the innermost store — is one
  continuous `strokeWidth: 3` spine; everything else is 2.
- Replicas: two offset rectangles plus `×N`, never N drawn copies.

### Value stream

- **Both ends are the customer**: trigger on the left, value received on the
  right. A stream that ends at an internal team is a process flow — reclassify.
- Stages are free text over one baseline `line`; a box only for the stage the
  argument is about. Work time and wait time go under each stage (14px muted),
  and the wait gaps are drawn to scale — wait dominates real streams, so let it.
- Handoff arrows only where the owner changes. No decision diamonds; branching
  belongs one altitude down.

### The rest, in brief

- **capability map**: nested tiles, two levels, NO arrows — capabilities do not
  call each other; the accent marks what is in scope.
- **value exchange**: parties around the offering, every edge a labeled exchange
  with its direction and what flows (money, service, data, attention). A party
  with only inbound or only outbound edges is a modeling error.
- **state machine**: rounded boxes, `event [guard] / action` on every
  transition, filled dot initial, ringed dot terminal, self-loops above.
- **control flow with gates**: the loop-back edge is the reason the figure
  exists — route it visibly outside the forward path, never through a node.
- **type relationships**: filled diamond at the whole, hollow triangle at the
  supertype.
- **mirrored comparison**: identical scaffold on both halves; only the differing
  part changes shape, and it is the only accent.
- **quantitative**, two different things. A **chart** (funnel/trend,
  distribution) is not an excalidraw job — inline SVG under the publish-page
  chart discipline, or the `dataviz` skill. **Numbers on a figure** (edge-rate,
  hop budget, hot-path) is that altitude's structural figure carrying one
  measured value per edge or hop, one unit, at the thing it measures; when
  ranking the numbers is the point rather than locating them, use a chart.

## Worked classifications

**"Can you draw how our onboarding actually works, end to end? It's for the
board."**
→ `business capability / behavioral / board → value stream`. The board audience
caps the altitude, so no system names and no technology lines; the decision
branches an engineer would add belong one altitude down.

**"Here's `models.py` — visualise the data model."**
→ `code-data / data / implementer → ERD (crow's foot)`. One entity per model
class; a nullable foreign key is zero-or-one, so the ellipse goes at the end
touching the parent.

**"Show how a request gets from the browser to the worker."**
→ `container / deployment / on-call engineer → deployment topology`. No
structural phrase and no inventory signal, so the tie-break never fires; add
"the architecture of our k3s platform" and rule 1 lands on the same type.
