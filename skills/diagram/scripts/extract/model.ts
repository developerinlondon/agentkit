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
// colliding with one silently reconfigures its parent instead of declaring a
// child. Directory and resource names like `steps`, `class` and `link` reach
// this list in practice.
const RESERVED = new Set([
  "class",
  "classes",
  "constraint",
  "direction",
  "grid-columns",
  "grid-gap",
  "grid-rows",
  "height",
  "horizontal-gap",
  "icon",
  "label",
  "layers",
  "left",
  "link",
  "near",
  "scenarios",
  "shape",
  "source-arrowhead",
  "steps",
  "style",
  "target-arrowhead",
  "tooltip",
  "top",
  "vars",
  "vertical-gap",
  "width",
]);

export function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safe = base === "" ? "n" : base;
  const prefixed = /^[0-9]/.test(safe) ? `n_${safe}` : safe;
  return RESERVED.has(prefixed) ? `${prefixed}_` : prefixed;
}

export function uniqueSlug(text: string, taken: Set<string>): string {
  const base = slug(text);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  taken.add(candidate);
  return candidate;
}

const CONTROL = /[\u0000-\u001f\u007f]/g;

// D2 reads an unquoted label up to the next structural character, so a label
// carrying one of them silently truncates or opens a block.
export function quote(label: string): string {
  const escaped = label
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
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

function emitNode(node: Node, indent: string): string[] {
  const label = node.tech === undefined ? node.label : `${node.label}\n${node.tech}`;
  const body: string[] = [];
  if (node.shape !== undefined) body.push(`${indent}  shape: ${node.shape}`);
  if (node.icon !== undefined) body.push(`${indent}  icon: @${node.icon}`);
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

function titleBlock(title: string): string[] {
  return [
    `title: ${quote(title)} {`,
    "  shape: text",
    "  near: top-center",
    "  style.font-size: 26",
    "}",
    "",
  ];
}

export function emit(graph: Graph, provenance: string): string {
  const zones = new Map(graph.zones.map((z) => [z.id, z]));
  const paths = new Map<string, string>();
  for (const node of graph.nodes) {
    if (paths.has(node.id)) throw new ExtractError(`duplicate node id: ${node.id}`);
    paths.set(node.id, nodePath(zones, node));
  }

  const lines = [`# ${provenance}`, "", `direction: ${graph.direction ?? "down"}`, ""];
  if (graph.title !== undefined) lines.push(...titleBlock(graph.title));
  for (const node of graph.nodes.filter((n) => n.zone === undefined)) {
    lines.push(...emitNode(node, ""));
  }
  for (const zone of graph.zones.filter((z) => z.parent === undefined)) {
    lines.push(...emitZone(graph, zone, ""));
  }
  lines.push("");
  for (const edge of graph.edges) lines.push(emitEdge(edge, paths));
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
