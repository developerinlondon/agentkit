// Baked excalidraw SVGs carry the navy palette; published outside the theme's
// .figure island (or an equivalent var(--diagram-bg) container) they land on
// whatever background the page provides — a white island shipped pale-on-white
// once, illegible in both themes. Refuse that shape at publish time.

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const EXCALIDRAW_MARK = "svg-source:excalidraw";
const CONTAINER_RE = /<(?:div|section|figure)\b[^>]*class="([^"]*)"[^>]*>/g;
const NEARBY = 600;

function styleBlocks(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
}

function classHasDiagramBg(cls: string, css: string): boolean {
  const rule = new RegExp(`\\.${cls}[^{]*\\{[^}]*var\\(--diagram-bg`);
  return rule.test(css);
}

export function lintFigures(html: string, allowBareSvg = false): LintResult {
  const result: LintResult = { errors: [], warnings: [] };
  const marks = [...html.matchAll(new RegExp(EXCALIDRAW_MARK, "g"))].map((m) => m.index ?? 0);
  if (marks.length === 0) return result;

  const css = styleBlocks(html);
  if (/background:\s*(white\b|#fff\b|#ffffff\b)/i.test(css)) {
    result.warnings.push(
      "page CSS hardcodes a white background while carrying a baked diagram — "
        + "if the diagram sits on it, use var(--diagram-bg) so both themes stay legible",
    );
  }
  if (allowBareSvg) return result;

  for (const at of marks) {
    const before = html.slice(Math.max(0, at - NEARBY * 8), at);
    const containers = [...before.matchAll(CONTAINER_RE)];
    const nearest = containers[containers.length - 1];
    const classes = nearest?.[1]?.split(/\s+/) ?? [];
    const distance = nearest ? before.length - (nearest.index ?? 0) : Infinity;
    const wrapped = distance <= NEARBY
      && (classes.includes("figure")
        || classes.some((c) => /^[A-Za-z0-9_-]+$/.test(c) && classHasDiagramBg(c, css)));
    if (!wrapped) {
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
