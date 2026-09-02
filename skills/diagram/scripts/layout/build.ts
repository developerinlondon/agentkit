import { arrow, bindArrow, scene, shape, text } from "./elements.ts";
import { type Box, FONT, type Layout, layout, MARGIN, type PlacedEdge } from "./geometry.ts";
import { textHeight, textWidth } from "./measure.ts";
import { labelInk, type Theme, theme } from "./palette.ts";
import { BUDGET, type DiagramSpec, type NodeSpec } from "./spec.ts";

type Json = Record<string, unknown>;

const SHAPE_TYPE = { rect: "rectangle", ellipse: "ellipse", diamond: "diamond" } as const;
const NOTE_GAP = 4;
const ARROW_GAP = 5;
const LABEL_CLEARANCE = 7;

function contentBounds(l: Layout): { x: number; y: number; right: number; bottom: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  const push = (x: number, y: number, w = 0, h = 0) => {
    xs.push(x, x + w);
    ys.push(y, y + h);
  };
  for (const z of l.zones.values()) push(z.x, z.y, z.width, z.height);
  for (const n of l.nodes.values()) push(n.x, n.y, n.width, n.height);
  for (const e of l.edges) {
    for (const [x, y] of e.points) push(x, y);
    if (e.labelBox) push(e.labelBox.x, e.labelBox.y, e.labelBox.width, e.labelBox.height);
  }
  return { x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function nodeTexts(n: NodeSpec, box: { x: number; y: number; width: number; height: number }, t: Theme, r: number): Json[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const ff = n.mono ? 3 : 1;
  const labelW = textWidth(n.label, ff, FONT.label);
  const labelH = textHeight(n.label, FONT.label);
  if (!n.note) {
    return [text(`${n.id}__label`, {
      x: cx - labelW / 2,
      y: cy - labelH / 2,
      width: labelW,
      height: labelH,
      text: n.label,
      color: labelInk(t, n.role),
      fontSize: FONT.label,
      fontFamily: ff,
      roughness: r,
    })];
  }
  const noteW = textWidth(n.note, 1, FONT.note);
  const noteH = textHeight(n.note, FONT.note);
  const top = cy - (labelH + NOTE_GAP + noteH) / 2;
  return [
    text(`${n.id}__label`, {
      x: cx - labelW / 2,
      y: top,
      width: labelW,
      height: labelH,
      text: n.label,
      color: labelInk(t, n.role),
      fontSize: FONT.label,
      fontFamily: ff,
      roughness: r,
    }),
    text(`${n.id}__note`, {
      x: cx - noteW / 2,
      y: top + labelH + NOTE_GAP,
      width: noteW,
      height: noteH,
      text: n.note,
      color: t.note,
      fontSize: FONT.note,
      fontFamily: 1,
      roughness: r,
    }),
  ];
}

/** Pull both ends back along their own segment so the head sits off the stroke. */
function trim(points: [number, number][]): [number, number][] {
  const p = points.map((q) => [...q] as [number, number]);
  const shift = (from: number, to: number) => {
    const [ax, ay] = p[to];
    const [bx, by] = p[from];
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= ARROW_GAP) return;
    p[to] = [ax + ((bx - ax) / len) * ARROW_GAP, ay + ((by - ay) / len) * ARROW_GAP];
  };
  shift(1, 0);
  shift(p.length - 2, p.length - 1);
  return p;
}

function edgeElements(e: PlacedEdge, i: number, shapes: Map<string, Json>, t: Theme, spec: DiagramSpec): Json[] {
  const source = spec.nodes.find((n) => n.id === e.from)!;
  const stroke = t.roles[e.role ?? source.role].stroke;
  const id = `edge_${i}`;
  const el = arrow(id, { points: trim(e.points), stroke, dashed: e.dashed, from: e.from, to: e.to, roughness: spec.roughness });
  bindArrow(shapes.get(e.from)!, id);
  bindArrow(shapes.get(e.to)!, id);
  if (!e.labelBox || !e.label) return [el];
  const w = textWidth(e.label, 1, FONT.edgeLabel);
  const h = textHeight(e.label, FONT.edgeLabel);
  return [el, text(`${id}__label`, {
    x: e.labelBox.x + e.labelBox.width / 2 - w / 2,
    y: e.labelBox.y + e.labelBox.height / 2 - h / 2,
    width: w,
    height: h,
    text: e.label,
    color: t.edgeLabel,
    fontSize: FONT.edgeLabel,
    fontFamily: 1,
    roughness: spec.roughness,
  })];
}

/** dagre centres an edge label on its edge; the text has to clear the stroke. */
function offEdge(box: Box, direction: DiagramSpec["direction"]): Box {
  return direction === "right"
    ? { ...box, y: box.y - box.height / 2 - LABEL_CLEARANCE }
    : { ...box, x: box.x + box.width / 2 + LABEL_CLEARANCE };
}

function checkCanvas(width: number, height: number): string[] {
  if (width > BUDGET.maxWidth || height > BUDGET.maxHeight) {
    throw new Error(
      `laid out at ${Math.round(width)}x${Math.round(height)}, past the ${BUDGET.maxWidth}x${BUDGET.maxHeight} ceiling `
        + `— split the figure, or set direction: down to restack it taller`,
    );
  }
  return width > BUDGET.warnWidth
    ? [`${Math.round(width)}px wide is over the ${BUDGET.warnWidth}px page budget; fonts must scale up or the figure must split`]
    : [];
}

function zoneElements(spec: DiagramSpec, l: Layout, t: Theme, move: <T extends Box>(o: T) => T): Json[] {
  const out: Json[] = [];
  for (const [id, box] of l.zones) {
    const z = move(box);
    out.push(shape(`zone_${id}`, "rectangle", {
      ...z,
      stroke: t.zoneStroke,
      fill: "transparent",
      dashed: true,
      strokeWidth: 1,
      rounded: true,
      roughness: spec.roughness,
    }));
    const label = spec.zones.find((sz) => sz.id === id)?.label;
    if (!label) continue;
    out.push(text(`zone_${id}__label`, {
      x: z.x + 20,
      y: z.y + 14,
      width: textWidth(label, 1, FONT.zoneTitle),
      height: textHeight(label, FONT.zoneTitle),
      text: label,
      color: t.zoneTitle,
      fontSize: FONT.zoneTitle,
      fontFamily: 1,
      roughness: spec.roughness,
    }));
  }
  return out;
}

function freeText(id: string, body: string, x: number, y: number, size: number, color: string, r: number): Json {
  return text(id, {
    x,
    y,
    width: textWidth(body, 1, size),
    height: textHeight(body, size),
    text: body,
    color,
    fontSize: size,
    fontFamily: 1,
    roughness: r,
  });
}

export interface Built {
  scene: Json;
  width: number;
  height: number;
  warnings: string[];
}

export function build(spec: DiagramSpec): Built {
  const l = layout(spec);
  const t = theme(spec.palette);
  const b = contentBounds(l);
  const titleBand = spec.title ? textHeight(spec.title, FONT.title) + 26 : 0;
  const dx = MARGIN - b.x;
  const dy = MARGIN + titleBand - b.y;
  const move = <T extends Box>(o: T): T => ({ ...o, x: o.x + dx, y: o.y + dy });

  const shapes = new Map<string, Json>();
  const labels: Json[] = [];
  for (const n of l.nodes.values()) {
    const box = move(n);
    const ink = t.roles[n.spec.role];
    shapes.set(n.spec.id, shape(n.spec.id, SHAPE_TYPE[n.spec.shape], {
      ...box,
      stroke: ink.stroke,
      fill: ink.fill,
      dashed: ink.dashed,
      rounded: n.spec.shape === "rect",
      roughness: spec.roughness,
    }));
    labels.push(...nodeTexts(n.spec, box, t, spec.roughness));
  }

  const arrows: Json[] = [];
  l.edges.forEach((e, i) => {
    const moved: PlacedEdge = {
      ...e,
      points: e.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
      labelBox: e.labelBox ? offEdge(move(e.labelBox), spec.direction) : undefined,
    };
    arrows.push(...edgeElements(moved, i, shapes, t, spec));
  });

  const bottom = b.bottom + dy;
  const noteStep = textHeight("x", FONT.pageNote) + 8;
  const notes = spec.notes.map((n, i) =>
    freeText(`note_${i}`, n, MARGIN, bottom + 24 + i * noteStep, FONT.pageNote, t.note, spec.roughness)
  );

  const width = b.right + dx + MARGIN;
  const last = notes.at(-1);
  const height = (last ? (last.y as number) + (last.height as number) : bottom) + MARGIN;
  const warnings = checkCanvas(width, height);
  const title = spec.title ? [freeText("figure_title", spec.title, MARGIN, MARGIN, FONT.title, t.title, spec.roughness)] : [];
  const backdrop = spec.background
    ? [shape("backdrop", "rectangle", {
      x: 0,
      y: 0,
      width,
      height,
      stroke: "transparent",
      fill: spec.background,
      strokeWidth: 1,
      roughness: 0,
    })]
    : [];

  const elements = [
    ...backdrop,
    ...zoneElements(spec, l, t, move),
    ...arrows,
    ...shapes.values(),
    ...labels,
    ...title,
    ...notes,
  ];
  return { scene: scene(elements, spec.background), width, height, warnings };
}
