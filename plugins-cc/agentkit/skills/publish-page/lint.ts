// Baked excalidraw SVGs carry the navy palette; published outside the theme's
// .figure island (or an equivalent var(--diagram-bg) container) they land on
// whatever background the page provides — a white island shipped pale-on-white
// once, illegible in both themes. Refuse that shape at publish time.

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXCALIDRAW_MARK = "svg-source:excalidraw";
const CONTAINER_RE = /<(?:div|section|figure)\b[^>]*class\s*=\s*["']([^"']*)["'][^>]*>/gi;
const TAG_RE = /<(\/?)(?:div|section|figure)\b/gi;
const NEARBY = 900;

function styleBlocks(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
}

function classHasDiagramBg(cls: string, css: string): boolean {
  // Anchored (`.dia` must not accept `.diagram` rules) and property-bound:
  // var(--diagram-bg) on a border while background stays white is the defect,
  // not a pass.
  const rule = new RegExp(
    `\\.${cls}(?![A-Za-z0-9_-])[^{]*\\{[^}]*background(?:-color)?:[^;}]*var\\(--diagram-bg`,
  );
  return rule.test(css);
}

// The container only covers the mark while it is still open. Depth must be
// walked in order — a close followed by a sibling open has equal totals but
// the island is already over.
function stillOpen(between: string): boolean {
  let depth = 0;
  for (const tag of between.matchAll(TAG_RE)) {
    depth += tag[1] === "/" ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

function isWrapped(before: string, css: string): boolean {
  const containers = [...before.matchAll(CONTAINER_RE)];
  for (const container of containers.reverse()) {
    const end = (container.index ?? 0) + container[0].length;
    if (before.length - end > NEARBY) return false;
    if (!stillOpen(before.slice(end))) continue;
    const classes = container[1].split(/\s+/);
    const qualifies = classes.includes("figure")
      || classes.some((c) => /^[A-Za-z0-9_-]+$/.test(c) && classHasDiagramBg(c, css));
    // A still-open container that does not qualify may itself sit inside a
    // qualifying island — keep walking outward.
    if (qualifies) return true;
  }
  return false;
}

export function lintFigures(html: string, allowBareSvg = false): LintResult {
  const result: LintResult = { errors: [], warnings: [] };
  const marks = [...html.matchAll(new RegExp(EXCALIDRAW_MARK, "g"))].map((m) => m.index ?? 0);
  if (marks.length === 0) return result;

  const css = styleBlocks(html);
  if (/background(?:-color)?:\s*(white\b|#fff\b|#ffffff\b|rgb\(\s*255\s*,\s*255\s*,\s*255)/i.test(css)) {
    result.warnings.push(
      "page CSS hardcodes a white background while carrying a baked diagram — "
        + "if the diagram sits on it, use var(--diagram-bg) so both themes stay legible",
    );
  }
  if (allowBareSvg) return result;

  for (const at of marks) {
    if (!isWrapped(html.slice(Math.max(0, at - NEARBY * 8), at), css)) {
      result.errors.push(
        "excalidraw SVG published outside a .figure island — wrap it in "
          + '<div class="figure">…<div class="figcaption">…</div></div>, or style its container '
          + "with background: var(--diagram-bg) so it stays legible in both themes "
          + "(--allow-bare-svg overrides)",
      );
    }
  }
  return result;
}
