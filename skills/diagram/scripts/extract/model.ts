// Graph model and D2 emission shared by the derive-from-source extractors.
// The ERD extractor emits `sql_table` syntax of its own; everything else here.

export class ExtractError extends Error {}

export interface Zone {
  id: string;
  label: string;
  parent?: string;
  dashed?: boolean;
}

export interface Node {
  id: string;
  label: string;
  tech?: string;
  icon?: string;
  shape?: string;
  zone?: string;
  multiple?: boolean;
}

export interface Edge {
  from: string;
  to: string;
  label?: string;
  bold?: boolean;
  dashed?: boolean;
}

export interface Graph {
  title?: string;
  direction?: string;
  zones: Zone[];
  nodes: Node[];
  edges: Edge[];
}

// D2 resolves these as configuration on the node that owns them, so a slug
// colliding with one reconfigures its parent instead of declaring a child.
// Only keywords slug() can actually emit belong here: its hyphenated spellings
// (`grid-rows`) never survive the separator collapse, so listing them would be
// cover that is not there.
export const RESERVED_WORDS = [
  "class",
  "classes",
  "constraint",
  "direction",
  "height",
  "icon",
  "label",
  "layers",
  "left",
  "link",
  "near",
  "scenarios",
  "shape",
  "steps",
  "style",
  "tooltip",
  "top",
  "vars",
  "width",
] as const;

const RESERVED = new Set<string>(RESERVED_WORDS);

export function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safe = base === "" ? "n" : base;
  const prefixed = /^[0-9]/.test(safe) ? `n_${safe}` : safe;
  return RESERVED.has(prefixed) ? `${prefixed}_` : prefixed;
}

function uniqueSlug(text: string, taken: Set<string>): string {
  const base = slug(text);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  taken.add(candidate);
  return candidate;
}

// One assigner per graph, shared by its containers and its nodes: they occupy
// the same key namespace, so `a-b` and `a_b` must not both become `a_b`.
export function idAssigner(): (text: string) => string {
  const taken = new Set<string>();
  return (text) => uniqueSlug(text, taken);
}

const CONTROL = /[\u0000-\u001f\u007f]/g;

// The single escaping sink: every field any extractor interpolates into D2
// goes through here, and a bypass is the whole vulnerability. Quoting alone is
// not enough — D2 substitutes `${...}` inside double quotes too, so a raw `$`
// aborts the render on an undeclared variable.
export function quote(label: string): string {
  const escaped = label
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replace(/\r\n?|\n/g, "\\n")
    .replace(CONTROL, " ");
  return `"${escaped}"`;
}

function nodePath(zones: Map<string, Zone>, node: Node): string {
  const parts: string[] = [];
  let zone = node.zone;
  const seen = new Set<string>();
  while (zone !== undefined && !seen.has(zone)) {
    seen.add(zone);
    parts.unshift(zone);
    zone = zones.get(zone)?.parent;
  }
  return [...parts, node.id].join(".");
}

// `shape` and `icon` are D2 keyword values, so they cannot be quoted the way a
// label can. They are constrained to a known alphabet instead — an extractor
// that ever derives one of them from source data must not open a second sink.
const BARE_VALUE = /^[a-z0-9][a-z0-9 :._-]*$/i;

function bare(value: string, key: string): string {
  if (!BARE_VALUE.test(value)) {
    throw new ExtractError(`unusable ${key} value ${JSON.stringify(value)}`);
  }
  return value;
}

function emitNode(node: Node, indent: string): string[] {
  const label = node.tech === undefined ? node.label : `${node.label}\n${node.tech}`;
  const body: string[] = [];
  if (node.shape !== undefined) body.push(`${indent}  shape: ${bare(node.shape, "shape")}`);
  if (node.icon !== undefined) body.push(`${indent}  icon: @${bare(node.icon, "icon")}`);
  if (node.multiple === true) body.push(`${indent}  style.multiple: true`);
  if (body.length === 0) return [`${indent}${node.id}: ${quote(label)}`];
  return [`${indent}${node.id}: ${quote(label)} {`, ...body, `${indent}}`];
}

function emitZone(graph: Graph, zone: Zone, indent: string): string[] {
  const lines = [`${indent}${zone.id}: ${quote(zone.label)} {`];
  if (zone.dashed === true) lines.push(`${indent}  style.stroke-dash: 4`);
  for (const node of graph.nodes.filter((n) => n.zone === zone.id)) {
    lines.push(...emitNode(node, `${indent}  `));
  }
  for (const child of graph.zones.filter((z) => z.parent === zone.id)) {
    lines.push(...emitZone(graph, child, `${indent}  `));
  }
  lines.push(`${indent}}`);
  return lines;
}

function emitEdge(edge: Edge, paths: Map<string, string>): string {
  const from = paths.get(edge.from);
  const to = paths.get(edge.to);
  if (from === undefined || to === undefined) {
    throw new ExtractError(`edge references an undeclared node: ${edge.from} -> ${edge.to}`);
  }
  const attrs: string[] = [];
  if (edge.bold === true) attrs.push("  style.bold: true");
  if (edge.dashed === true) attrs.push("  style.stroke-dash: 4");
  const head = `${from} -> ${to}${edge.label === undefined ? "" : `: ${quote(edge.label)}`}`;
  return attrs.length === 0 ? head : [`${head} {`, ...attrs, "}"].join("\n");
}

// SKILL.md caps a figure at roughly a dozen labelled nodes and splits rather
// than shrinks past it. A derived graph blows through that without noticing,
// so the budget is enforced here rather than left to the reader's eye.
export const DEFAULT_MAX_NODES = 12;

export function assertDensity(graph: Graph, max: number, lever: string): void {
  if (graph.nodes.length <= max) return;
  throw new ExtractError(
    `${graph.nodes.length} nodes exceeds the density budget of ${max} — a figure this `
      + `dense argues nothing. Narrow the scope (${lever}), or raise the budget `
      + `deliberately with --max-nodes.`,
  );
}

export function titleBlock(title: string): string[] {
  return [
    `title: ${quote(title)} {`,
    "  shape: text",
    "  near: top-center",
    "  style.font-size: 26",
    "}",
    "",
  ];
}

export function header(provenance: string, direction: string | undefined): string[] {
  // A newline here would end the comment and turn the rest into D2 source.
  return [`# ${provenance.replace(/[\r\n]+/g, " ")}`, "", `direction: ${bare(direction ?? "down", "direction")}`, ""];
}

export function finish(lines: readonly string[]): string {
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// Nodes and containers share one key namespace, and both are addressed by id —
// a node by its edges, a container by the `zone` its children name. Two of
// either colliding is ambiguous, and D2 merges same-key blocks rather than
// complaining, so the figure would come out confidently mislabelled.
function assertUniqueIds(graph: Graph): void {
  const seen = new Map<string, string>();
  const claim = (id: string, kind: string, label: string): void => {
    const held = seen.get(id);
    if (held !== undefined) {
      throw new ExtractError(
        `duplicate ${kind} id "${id}" — ${JSON.stringify(label)} collides with `
          + `${JSON.stringify(held)}. Two names that differ only by their separators slug `
          + `alike; narrow the scope so only one of them is drawn.`,
      );
    }
    seen.set(id, label);
  };
  for (const zone of graph.zones) claim(zone.id, "container", zone.label);
  for (const node of graph.nodes) claim(node.id, "node", node.label);
}

export function emit(graph: Graph, provenance: string): string {
  assertUniqueIds(graph);
  const zones = new Map(graph.zones.map((z) => [z.id, z]));
  const paths = new Map<string, string>();
  for (const node of graph.nodes) paths.set(node.id, nodePath(zones, node));

  const lines = header(provenance, graph.direction);
  if (graph.title !== undefined) lines.push(...titleBlock(graph.title));
  for (const node of graph.nodes.filter((n) => n.zone === undefined)) {
    lines.push(...emitNode(node, ""));
  }
  for (const zone of graph.zones.filter((z) => z.parent === undefined)) {
    lines.push(...emitZone(graph, zone, ""));
  }
  lines.push("");
  for (const edge of graph.edges) lines.push(emitEdge(edge, paths));
  return finish(lines);
}
