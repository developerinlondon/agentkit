import dagre from "@dagrejs/dagre";
import { textHeight, textWidth } from "./measure.ts";
import type { DiagramSpec, NodeSpec } from "./spec.ts";

export const FONT = { title: 24, zoneTitle: 20, label: 16, note: 13, edgeLabel: 14, pageNote: 14 };
export const MARGIN = 30;

const MIN_W = 140;
const PAD_X = 44;
const H_LABEL = 48;
const H_NOTE = 66;
const SHAPE_INFLATE: Record<string, [number, number]> = { rect: [1, 1], ellipse: [1.3, 1.45], diamond: [1.6, 1.9] };
const ZONE_PAD = { x: 22, bottom: 22 };
const PAD_Y = 28;
export const NOTE_GAP = 4;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedNode extends Box {
  spec: NodeSpec;
}

export interface PlacedEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
  role?: string;
  points: [number, number][];
  labelBox?: Box;
}

export interface Layout {
  nodes: Map<string, PlacedNode>;
  zones: Map<string, Box>;
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export function nodeSize(n: NodeSpec): { width: number; height: number } {
  const labelW = textWidth(n.label, n.mono ? 3 : 1, FONT.label);
  const noteW = n.note ? textWidth(n.note, 1, FONT.note) : 0;
  const [fx, fy] = SHAPE_INFLATE[n.shape];
  const width = Math.max(MIN_W, Math.ceil((Math.max(labelW, noteW) + PAD_X) * fx / 10) * 10);
  const textH = textHeight(n.label, FONT.label) + (n.note ? NOTE_GAP + textHeight(n.note, FONT.note) : 0);
  const floor = n.note ? H_NOTE : H_LABEL;
  return { width, height: Math.round(Math.max(floor, textH + PAD_Y) * fy) };
}

function edgeLabelSize(label: string | undefined): { width: number; height: number } {
  if (!label) return { width: 0, height: 0 };
  return { width: Math.ceil(textWidth(label, 1, FONT.edgeLabel)) + 12, height: Math.round(FONT.edgeLabel * 1.25) + 8 };
}

function runDagre(spec: DiagramSpec, sep: number): dagre.graphlib.Graph {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({
    rankdir: spec.direction === "right" ? "LR" : "TB",
    nodesep: sep,
    ranksep: Math.round(sep * 2),
    edgesep: 24,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const z of spec.zones) g.setNode(z.id, {});
  // dagre seeds its ordering pass by walking insertion order backwards, so
  // siblings come out mirrored; feeding it reversed restores declared order.
  for (const n of [...spec.nodes].reverse()) {
    g.setNode(n.id, nodeSize(n));
    if (n.zone) g.setParent(n.id, n.zone);
  }
  spec.edges.map((e, i) => [e, i] as const).reverse().forEach(([e, i]) => {
    g.setEdge(e.from, e.to, { ...edgeLabelSize(e.label), labelpos: "c" }, `e${i}`);
  });
  dagre.layout(g);
  return g;
}

function boxOf(v: { x: number; y: number; width: number; height: number }): Box {
  return { x: v.x - v.width / 2, y: v.y - v.height / 2, width: v.width, height: v.height };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** dagre's cluster box hugs its children; the frame needs room for its own title. */
function padZone(box: Box, children: Box[], titleSpace: number): Box {
  const minX = Math.min(...children.map((c) => c.x)) - ZONE_PAD.x;
  const maxX = Math.max(...children.map((c) => c.x + c.width)) + ZONE_PAD.x;
  const minY = Math.min(...children.map((c) => c.y)) - titleSpace;
  const maxY = Math.max(...children.map((c) => c.y + c.height)) + ZONE_PAD.bottom;
  return {
    x: Math.min(box.x, minX),
    y: Math.min(box.y, minY),
    width: Math.max(box.x + box.width, maxX) - Math.min(box.x, minX),
    height: Math.max(box.y + box.height, maxY) - Math.min(box.y, minY),
  };
}

function collect(spec: DiagramSpec, g: dagre.graphlib.Graph): Layout {
  const nodes = new Map<string, PlacedNode>();
  for (const n of spec.nodes) nodes.set(n.id, { ...boxOf(g.node(n.id)), spec: n });
  const zones = new Map<string, Box>();
  for (const z of spec.zones) {
    const children = spec.nodes.filter((n) => n.zone === z.id).map((n) => nodes.get(n.id)!);
    if (children.length === 0) throw new Error(`zone "${z.id}" has no nodes`);
    zones.set(z.id, padZone(boxOf(g.node(z.id)), children, z.label ? FONT.zoneTitle * 1.25 + 22 : ZONE_PAD.bottom));
  }
  const edges: PlacedEdge[] = spec.edges.map((e, i) => {
    const d = g.edge({ v: e.from, w: e.to, name: `e${i}` });
    return {
      from: e.from,
      to: e.to,
      label: e.label,
      dashed: e.dashed,
      role: e.role,
      points: d.points.map((p: { x: number; y: number }) => [p.x, p.y] as [number, number]),
      labelBox: e.label ? boxOf({ x: d.x, y: d.y, ...edgeLabelSize(e.label) }) : undefined,
    };
  });
  const graph = g.graph() as { width: number; height: number };
  return { nodes, zones, edges, width: graph.width, height: graph.height };
}

function zonesAreClean(spec: DiagramSpec, l: Layout): boolean {
  const zoneList = [...l.zones.entries()];
  for (let i = 0; i < zoneList.length; i++) {
    for (let j = i + 1; j < zoneList.length; j++) if (overlaps(zoneList[i][1], zoneList[j][1])) return false;
    for (const n of l.nodes.values()) {
      if (n.spec.zone !== zoneList[i][0] && overlaps(zoneList[i][1], n)) return false;
    }
  }
  return true;
}

/** Widening the ranks is the only lever that separates padded zone frames. */
export function layout(spec: DiagramSpec): Layout {
  let result: Layout | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    result = collect(spec, runDagre(spec, 46 + attempt * 40));
    if (zonesAreClean(spec, result)) return result;
  }
  throw new Error("zone frames still overlap after widening the ranks — reduce zones or split the figure");
}
