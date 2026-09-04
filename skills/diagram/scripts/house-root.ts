// The root contract every SVG register ships, and the error type they all throw.

export class SvgError extends Error {}

// The cap the page applies. It is a maximum, not a width: the natural size
// below is what a figure narrower than the column renders at.
export const HOUSE_STYLE = "max-width:100%;height:auto";

const VIEWBOX_RE = /\bviewBox="([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)"/;

// Rounded up rather than truncated: a fractional viewBox truncated down clips
// the last row of pixels wherever the SVG is used without CSS.
export function naturalSize(tag: string): { width: number; height: number } {
  const box = tag.match(VIEWBOX_RE);
  if (!box) throw new SvgError("cannot size the root — no viewBox on the rendered SVG");
  const width = Math.ceil(Number(box[3]));
  const height = Math.ceil(Number(box[4]));
  if (!(width > 0) || !(height > 0)) {
    throw new SvgError(`viewBox does not describe a positive size: ${box[0]}`);
  }
  return { width, height };
}

export interface HouseRoot {
  label: string;
  className?: string;
  sourceMark?: string;
  dropPriorStyle?: boolean;
}

// The root every register ships: the natural size the page caps against, the
// viewBox the lightbox expands from, and the label a screen reader reads.
export function houseRoot(svg: string, spec: HouseRoot): string {
  const open = svg.match(/^<svg\b[^>]*>/);
  if (!open) throw new SvgError("output does not start with an <svg> tag");
  const { width, height } = naturalSize(open[0]);
  // Two style attributes on one tag is not a merge — the browser reads the
  // first, and the cap would be dead markup.
  const prior = spec.dropPriorStyle ? undefined : open[0].match(/\bstyle="([^"]*)"/)?.[1];
  const style = prior ? `${prior};${HOUSE_STYLE}` : HOUSE_STYLE;
  const label = spec.label.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const className = spec.className ? `class="${spec.className}" ` : "";
  const tag = open[0]
    .replace(/\s*\bwidth="[^"]*"/, "")
    .replace(/\s*\bheight="[^"]*"/, "")
    .replace(/\s*\bstyle="[^"]*"/, "")
    // A label is data, and `$&` in a replacement string is not: as a literal it
    // would splice the matched tag back into the attribute it just escaped.
    .replace(
      /^<svg\b/,
      () =>
        `<svg ${className}role="img" aria-label="${label}" width="${width}" height="${height}" style="${style}"`,
    );
  const mark = spec.sourceMark ? `<!-- ${spec.sourceMark} -->\n` : "";
  return `${mark}${tag}${svg.slice(open[0].length)}`;
}

