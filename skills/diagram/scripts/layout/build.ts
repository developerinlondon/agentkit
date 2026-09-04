import { arrow, bindArrow, scene, shape, text } from "./elements.ts";
import { type Box, FONT, type Layout, layout, MARGIN, NOTE_GAP, type PlacedEdge } from "./geometry.ts";
import { textHeight, textWidth } from "./measure.ts";
import { labelInk, type Theme, theme } from "./palette.ts";
import { betterFit, type Direction, DIRECTIONS, orientationEvidence, type Sized } from "../orientation.ts";
import { BUDGET, type DiagramSpec, type NodeSpec, type PlacedSpec } from "./spec.ts";

type Json = Record<string, unknown>;

const SHAPE_TYPE = { rect: "rectangle", ellipse: "ellipse", diamond: "diamond" } as const;
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

function bboxOf(e: Json): Box {
  const x = e.x as number;
  const y = e.y as number;
  if (e.type !== "arrow") return { x, y, width: e.width as number, height: e.height as number };
  const pts = e.points as [number, number][];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    x: x + Math.min(...xs),
    y: y + Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** One pass over everything drawn, so a label wider or taller than its box
 * still lands inside the canvas the budget is checked against. */
function normalize(elements: Json[]): { width: number; height: number } {
  const boxes = elements.map(bboxOf);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  for (const e of elements) {
    e.x = (e.x as number) + MARGIN - minX;
    e.y = (e.y as number) + MARGIN - minY;
  }
  return { width: maxX - minX + 2 * MARGIN, height: maxY - minY + 2 * MARGIN };
}

/** dagre centres an edge label on its edge; the text has to clear the stroke. */
function offEdge(box: Box, direction: Direction): Box {
  return direction === "right"
    ? { ...box, y: box.y - box.height / 2 - LABEL_CLEARANCE }
    : { ...box, x: box.x + box.width / 2 + LABEL_CLEARANCE };
}

/** The restack is only worth naming to an author who chose left-to-right and
 * still has the other orientation in hand; it has already been tried under
 * auto, and it is what a down layout just failed at. */
function checkCanvas(width: number, height: number, offerRestack: boolean): string[] {
  if (width > BUDGET.maxWidth || height > BUDGET.maxHeight) {
    const remedy = offerRestack ? "— split the figure, or set direction: down to restack it taller" : "— split the figure";
    throw new Error(
      `laid out at ${Math.round(width)}x${Math.round(height)}, past the ${BUDGET.maxWidth}x${BUDGET.maxHeight} ceiling `
        + remedy,
    );
  }
  return width > BUDGET.warnWidth
    ? [`${Math.round(width)}px wide is over the ${BUDGET.warnWidth}px page budget; fonts must scale up or the figure must split`]
    : [];
}

function zoneElements(spec: PlacedSpec, l: Layout, t: Theme): Json[] {
  const out: Json[] = [];
  for (const [id, box] of l.zones) {
    const z = box;
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
  direction: Direction;
  /** One line naming the orientation this spec did not ask for, and its rival. */
  evidence?: string;
}

function buildOne(spec: PlacedSpec, auto = false): Built {
  const l = layout(spec);
  const t = theme(spec.palette);
  const b = contentBounds(l);

  const shapes = new Map<string, Json>();
  const labels: Json[] = [];
  for (const n of l.nodes.values()) {
    const ink = t.roles[n.spec.role];
    shapes.set(n.spec.id, shape(n.spec.id, SHAPE_TYPE[n.spec.shape], {
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      stroke: ink.stroke,
      fill: ink.fill,
      dashed: ink.dashed,
      rounded: n.spec.shape === "rect",
      roughness: spec.roughness,
    }));
    labels.push(...nodeTexts(n.spec, n, t, spec.roughness));
  }

  const arrows: Json[] = [];
  l.edges.forEach((e, i) => {
    const laid: PlacedEdge = { ...e, labelBox: e.labelBox ? offEdge(e.labelBox, spec.direction) : undefined };
    arrows.push(...edgeElements(laid, i, shapes, t, spec));
  });

  const title = spec.title
    ? [freeText(
      "figure_title",
      spec.title,
      b.x,
      b.y - textHeight(spec.title, FONT.title) - 26,
      FONT.title,
      t.title,
      spec.roughness,
    )]
    : [];
  const noteStep = textHeight("x", FONT.pageNote) + 8;
  const notes = spec.notes.map((n, i) =>
    freeText(`note_${i}`, n, b.x, b.bottom + 24 + i * noteStep, FONT.pageNote, t.note, spec.roughness)
  );

  const elements = [...zoneElements(spec, l, t), ...arrows, ...shapes.values(), ...labels, ...title, ...notes];
  const { width, height } = normalize(elements);
  const warnings = checkCanvas(width, height, !auto && spec.direction === "right");
  if (spec.background) {
    elements.unshift(shape("backdrop", "rectangle", {
      x: 0,
      y: 0,
      width,
      height,
      stroke: "transparent",
      fill: spec.background,
      strokeWidth: 1,
      roughness: 0,
    }));
  }
  return { scene: scene(elements, spec.background), width, height, warnings, direction: spec.direction };
}

interface Attempt {
  direction: Direction;
  built?: Built;
  failure?: Error;
}

function attempt(spec: DiagramSpec, direction: Direction): Attempt {
  try {
    return { direction, built: buildOne({ ...spec, direction }, true) };
  } catch (e) {
    return { direction, failure: e as Error };
  }
}

function sized(a: Attempt): Sized {
  return { direction: a.direction, width: a.built!.width, height: a.built!.height };
}

export function build(spec: DiagramSpec): Built {
  if (spec.direction !== "auto") return buildOne({ ...spec, direction: spec.direction });
  const tried = DIRECTIONS.map((d) => attempt(spec, d));
  const drawn = tried.filter((a) => a.built);
  if (drawn.length === 0) {
    throw new Error(
      `neither orientation fits — as right: ${tried[0].failure!.message}; as down: ${tried[1].failure!.message}`,
    );
  }
  if (drawn.length === 1) {
    const only = drawn[0].built!;
    const beaten = tried.find((a) => a.failure)!.direction;
    const size = `${Math.round(only.width)}x${Math.round(only.height)}`;
    return { ...only, evidence: `orientation: ${only.direction} (${size}) — ${beaten} does not fit` };
  }
  const { kept, dropped } = betterFit(sized(drawn[0]), sized(drawn[1]));
  const winner = drawn.find((a) => a.direction === kept.direction)!;
  return { ...winner.built!, evidence: orientationEvidence(kept, dropped) };
}
