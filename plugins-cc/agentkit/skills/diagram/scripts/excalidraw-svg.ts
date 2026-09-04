// Post-processing for Excalidraw SVG output.

import { HOUSE_STYLE, naturalSize, SvgError } from "./d2-svg.ts";

// Every register throws the one error type; the sketch scripts import it from
// here, which is where it lived before the root contract became shared.
export { SvgError };

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

// The same root every register ships: the natural size the page caps against,
// the viewBox the lightbox expands from, and the label a screen reader reads.
// Excalidraw writes the size and the viewBox; the rest is added here so the
// sketch register is not the one that has to be fixed up by hand.
export function applyHouseAttributes(svg: string, ariaLabel: string): string {
  const open = svg.match(/^<svg\b[^>]*>/);
  if (!open) throw new SvgError("output does not start with an <svg> tag");
  let tag = open[0];
  const { width, height } = naturalSize(tag);
  // Excalidraw ships no root style today, but two style attributes on one tag
  // is not a merge — the browser reads the first and the cap would be dead.
  const prior = tag.match(/\bstyle="([^"]*)"/)?.[1];
  tag = tag.replace(/\s*\bwidth="[^"]*"/, "").replace(/\s*\bheight="[^"]*"/, "")
    .replace(/\s*\bstyle="[^"]*"/, "");
  const style = prior ? `${prior};${HOUSE_STYLE}` : HOUSE_STYLE;
  const escaped = ariaLabel.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  tag = tag.replace(
    /^<svg\b/,
    `<svg role="img" aria-label="${escaped}" width="${width}" height="${height}" style="${style}"`,
  );
  return tag + svg.slice(open[0].length);
}
