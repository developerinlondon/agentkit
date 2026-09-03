// Post-processing for Excalidraw SVG output.

export class SvgError extends Error {}

// A baked-ink sketch has no ground of its own once inlined into a
// theme-switching host — the strokes survive a theme flip, the page
// underneath does not.
export function backgroundRect(svg: string, fill: string): string {
  const root = svg.match(/^<svg\b[^>]*>/);
  if (!root) throw new SvgError("cannot attach a background — no <svg> root");
  const box = root[0].match(/\bviewBox="([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+)"/);
  if (!box) throw new SvgError("cannot attach a background — no viewBox on the rendered SVG");
  const [, x, y, w, h] = box;
  const escaped = fill.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const rect = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${escaped}"/>`;
  return root[0] + rect + svg.slice(root[0].length);
}

// "transparent" (Excalidraw's own no-background value) and an absent or
// blank colour both mean no rect, matching today's behaviour.
export function resolveBackground(explicit: string | undefined, sceneColor: unknown): string | undefined {
  const raw = explicit ?? (typeof sceneColor === "string" ? sceneColor : undefined);
  const color = raw?.trim();
  if (!color || color.toLowerCase() === "transparent") return undefined;
  return color;
}
