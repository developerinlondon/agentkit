// Baked excalidraw SVGs carry the dark house palette; published outside the theme's
// .figure island (or an equivalent var(--diagram-bg) container) they land on
// whatever background the page provides — a white island shipped pale-on-white
// once, illegible in both themes. Refuse that shape at publish time.

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const SOURCE_MARK = /svg-source:(?:excalidraw|d2)/g;
const CONTAINER_RE = /<(?:div|section|figure)\b[^>]*class\s*=\s*["']([^"']*)["'][^>]*>/gi;
const TAG_RE = /<(\/?)(?:div|section|figure)\b/gi;
const NEARBY = 900;

// d2 salts its own classes as .d2-<digits> and always ships
// .background-color-N7{background-color:#FFFFFF}, which reads as a white page
// ground. Only those rules are dropped: discarding the whole element would take
// an author's own declarations with them, and the house theme ships one <style>
// for the entire page.
const D2_RULE = /[^{}]*\.d2-(?:\d+|mono)[^{}]*\{[^}]*\}/g;

function styleBlocks(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1].replace(D2_RULE, ""))
    .join("\n");
}

// A mangled inline SVG still looks like a figure to every structural check —
// the island is there, the caption is there, and the diagram is a wall of text.
// Real rules live inside a <style> element, which is stripped before this runs;
// a d2 selector surviving as text means the markup was escaped into prose.
const LEAKED_CSS = /\.d2-(?:\d+|mono)\s*(?:\{|\.(?:fill|stroke|background-color))/;

// Two shapes, because stripping <style> spans first can delete the evidence: a
// leak that lands between a style open and a still-present close is swallowed by
// the strip, so escaped markup is checked against the raw page as well.
const ESCAPED_MARKUP = /&lt;\/(?:svg|style)&gt;/;

function leakedStylesheet(html: string): boolean {
  if (ESCAPED_MARKUP.test(html) && /\.d2-(?:\d+|mono)/.test(html)) return true;
  const stripped = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  return LEAKED_CSS.test(stripped);
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
  const marks = [...html.matchAll(SOURCE_MARK)].map((m) => m.index ?? 0);
  if (marks.length === 0) return result;

  // A warning, not an error: the same shape is produced by a page that documents
  // d2 CSS in a fence, and blocking that publish is worse than the leak it
  // guards — which the renderer no longer emits in the first place.
  if (leakedStylesheet(html)) {
    result.warnings.push(
      "a d2 selector appears as page text — if a figure renders as raw CSS, the inlined "
        + "SVG carries a blank or indented line and needs re-rendering; if you are "
        + "documenting d2 CSS deliberately, ignore this",
    );
  }

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
        "baked SVG published outside a .figure island — wrap it in "
          + '<div class="figure">…<div class="figcaption">…</div></div>, or style its container '
          + "with background: var(--diagram-bg) so it stays legible in both themes "
          + "(--allow-bare-svg overrides)",
      );
    }
  }
  return result;
}
