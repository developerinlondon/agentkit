type Json = Record<string, unknown>;

/** Deterministic per-id seed: the same spec must render byte-identically twice. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2000000000;
}

function base(id: string, type: string, roughness: number): Json {
  const seed = seedOf(id);
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness,
    opacity: 100,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

export interface ShapeOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  fill: string;
  dashed?: boolean;
  strokeWidth?: number;
  rounded?: boolean;
  roughness: number;
}

export function shape(id: string, type: "rectangle" | "ellipse" | "diamond", o: ShapeOpts): Json {
  return {
    ...base(id, type, o.roughness),
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    strokeColor: o.stroke,
    backgroundColor: o.fill,
    strokeWidth: o.strokeWidth ?? 2,
    strokeStyle: o.dashed ? "dashed" : "solid",
    ...(o.rounded && type === "rectangle" ? { roundness: { type: 3 } } : {}),
  };
}

export interface TextOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  fontSize: number;
  fontFamily: number;
  roughness: number;
}

export function text(id: string, o: TextOpts): Json {
  return {
    ...base(id, "text", o.roughness),
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    strokeColor: o.color,
    strokeWidth: 1,
    text: o.text,
    originalText: o.text,
    fontSize: o.fontSize,
    fontFamily: o.fontFamily,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  };
}

export interface ArrowOpts {
  points: [number, number][];
  stroke: string;
  dashed?: boolean;
  from: string;
  to: string;
  roughness: number;
}

export function arrow(id: string, o: ArrowOpts): Json {
  const [ox, oy] = o.points[0];
  const rel = o.points.map(([x, y]) => [x - ox, y - oy]);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  return {
    ...base(id, "arrow", o.roughness),
    x: ox,
    y: oy,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    strokeColor: o.stroke,
    strokeStyle: o.dashed ? "dashed" : "solid",
    points: rel,
    startBinding: { elementId: o.from, focus: 0, gap: 4 },
    endBinding: { elementId: o.to, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: "arrow",
    lastCommittedPoint: null,
    elbowed: false,
  };
}

/** Bindings are two-way: a shape must list every arrow that touches it. */
export function bindArrow(shapeEl: Json, arrowId: string): void {
  const existing = (shapeEl.boundElements as { id: string; type: string }[] | null) ?? [];
  shapeEl.boundElements = [...existing, { id: arrowId, type: "arrow" }];
}

export function scene(elements: Json[], background?: string): Json {
  return {
    type: "excalidraw",
    version: 2,
    source: "agentkit-diagram-layout",
    elements,
    appState: { viewBackgroundColor: background ?? "transparent", gridSize: null },
    files: {},
  };
}
