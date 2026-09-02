import { YAML } from "bun";

export type Direction = "right" | "down";
export type Palette = "light" | "dark";
export type Shape = "rect" | "ellipse" | "diamond";
export type Role = "neutral" | "start" | "success" | "decision" | "agent" | "inactive" | "error" | "evidence";

export interface NodeSpec {
  id: string;
  label: string;
  note?: string;
  role: Role;
  shape: Shape;
  zone?: string;
  mono: boolean;
}

export interface ZoneSpec {
  id: string;
  label?: string;
}

export interface EdgeSpec {
  from: string;
  to: string;
  label?: string;
  role?: Role;
  dashed: boolean;
}

export interface DiagramSpec {
  title?: string;
  direction: Direction;
  palette: Palette;
  roughness: 0 | 1;
  background?: string;
  nodes: NodeSpec[];
  zones: ZoneSpec[];
  edges: EdgeSpec[];
  notes: string[];
}

/** The sketch register's density budget (SKILL.md, "Size & density budget"). */
export const BUDGET = { zones: 3, nodes: 12, warnWidth: 1000, maxWidth: 1200, maxHeight: 1400 };

const ROLES: Role[] = ["neutral", "start", "success", "decision", "agent", "inactive", "error", "evidence"];
const SHAPES: Shape[] = ["rect", "ellipse", "diamond"];

function bad(msg: string): never {
  throw new Error(msg);
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") bad(`${where} must be a non-empty string`);
  return (v as string).trim();
}

function pick<T extends string>(v: unknown, allowed: T[], fallback: T, where: string): T {
  if (v === undefined || v === null) return fallback;
  if (!allowed.includes(v as T)) bad(`${where}: "${String(v)}" is not one of ${allowed.join(", ")}`);
  return v as T;
}

/** An unrecognised key is a typo or an unquoted comma, never a silent no-op. */
function only(v: unknown, keys: string[], where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(`${where} must be a mapping`);
  const o = v as Record<string, unknown>;
  const stray = Object.keys(o).filter((k) => !keys.includes(k));
  if (stray.length > 0) bad(`${where}: unknown key${stray.length > 1 ? "s" : ""} ${stray.join(", ")} — allowed: ${keys.join(", ")}`);
  return o;
}

function asList(v: unknown, where: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad(`${where} must be a list`);
  return v;
}

function parseNode(raw: unknown, i: number): NodeSpec {
  const n = only(raw, ["id", "label", "note", "role", "shape", "zone", "mono"], `nodes[${i}]`);
  return {
    id: str(n.id, `nodes[${i}].id`),
    label: str(n.label, `nodes[${i}].label`),
    note: n.note === undefined ? undefined : str(n.note, `nodes[${i}].note`),
    role: pick(n.role, ROLES, "neutral", `nodes[${i}].role`),
    shape: pick(n.shape, SHAPES, "rect", `nodes[${i}].shape`),
    zone: n.zone === undefined ? undefined : str(n.zone, `nodes[${i}].zone`),
    mono: n.mono === true,
  };
}

function parseEdge(raw: unknown, i: number): EdgeSpec {
  const e = only(raw, ["from", "to", "label", "role", "dashed"], `edges[${i}]`);
  return {
    from: str(e.from, `edges[${i}].from`),
    to: str(e.to, `edges[${i}].to`),
    label: e.label === undefined ? undefined : str(e.label, `edges[${i}].label`),
    role: e.role === undefined ? undefined : pick(e.role, ROLES, "neutral", `edges[${i}].role`),
    dashed: e.dashed === true,
  };
}

function checkReferences(spec: DiagramSpec): void {
  const ids = new Set<string>();
  for (const n of spec.nodes) {
    if (ids.has(n.id)) bad(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  const zoneIds = new Set(spec.zones.map((z) => z.id));
  for (const z of zoneIds) if (ids.has(z)) bad(`zone id "${z}" collides with a node id`);
  for (const n of spec.nodes) {
    if (n.zone && !zoneIds.has(n.zone)) bad(`node "${n.id}" names zone "${n.zone}", which is not declared`);
  }
  for (const e of spec.edges) {
    if (!ids.has(e.from)) bad(`edge ${e.from} -> ${e.to}: no node "${e.from}"`);
    if (!ids.has(e.to)) bad(`edge ${e.from} -> ${e.to}: no node "${e.to}"`);
  }
}

function checkBudget(spec: DiagramSpec): void {
  if (spec.nodes.length === 0) bad("a spec needs at least one node");
  if (spec.zones.length > BUDGET.zones) {
    bad(`${spec.zones.length} zones exceeds the register's budget of ${BUDGET.zones} — split, don't shrink`);
  }
  if (spec.nodes.length > BUDGET.nodes) {
    bad(`${spec.nodes.length} nodes exceeds the register's budget of ${BUDGET.nodes} — split, don't shrink`);
  }
}

export function parseSpec(source: string): DiagramSpec {
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (e) {
    bad(`spec is not valid YAML or JSON: ${(e as Error).message}`);
  }
  const r = only(raw, ["title", "direction", "palette", "roughness", "background", "nodes", "zones", "edges", "notes"], "spec");
  const spec: DiagramSpec = {
    title: r.title === undefined ? undefined : str(r.title, "title"),
    direction: pick(r.direction, ["right", "down"] as Direction[], "right", "direction"),
    palette: pick(r.palette, ["light", "dark"] as Palette[], "dark", "palette"),
    roughness: r.roughness === 0 ? 0 : 1,
    background: r.background === undefined ? undefined : str(r.background, "background"),
    nodes: asList(r.nodes, "nodes").map(parseNode),
    zones: asList(r.zones, "zones").map((z, i) => {
      const o = only(z, ["id", "label"], `zones[${i}]`);
      return { id: str(o.id, `zones[${i}].id`), label: o.label === undefined ? undefined : str(o.label, `zones[${i}].label`) };
    }),
    edges: asList(r.edges, "edges").map(parseEdge),
    notes: asList(r.notes, "notes").map((n, i) => str(n, `notes[${i}]`)),
  };
  checkReferences(spec);
  checkBudget(spec);
  return spec;
}
