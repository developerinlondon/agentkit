// Post-processing and verification for d2 SVG output.

export const D2_PIN = "0.7.1";
export const SOURCE_MARK = "svg-source:d2";

export class SvgError extends Error {}

// Namespace declarations are identifiers, not fetches; every other absolute
// URL in the output would be a runtime dependency on the network.
const ALLOWED_URLS = new Set([
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/XML/1998/namespace",
]);
const URL_RE = /https?:\/\/[^"'\s)>]+/g;
const DARK_MEDIA = "@media screen and (prefers-color-scheme:dark){";

function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new SvgError("unbalanced braces in d2 stylesheet");
}

function prefixSelectors(rules: string, prefix: string): string {
  return rules.replace(/([^{}]+)\{([^{}]*)\}/g, (_m, selector: string, decls: string) => {
    const prefixed = selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `${prefix} ${s}`)
      .join(",");
    return `${prefixed}{${decls}}`;
  });
}

// d2 gates its dark palette on the OS preference. The house page toggles
// html[data-theme], so the guard is rewritten to follow the page. Standalone
// (no <html> ancestor) the selector cannot match and the light palette stands.
export function retargetDarkTheme(svg: string, prefix = 'html:not([data-theme="light"])'): string {
  const at = svg.indexOf(DARK_MEDIA);
  if (at === -1) return svg;
  const open = at + DARK_MEDIA.length - 1;
  const close = matchingBrace(svg, open);
  const rules = svg.slice(open + 1, close);
  return svg.slice(0, at) + prefixSelectors(rules, prefix) + svg.slice(close + 1);
}

// The island supplies the surface; d2's own full-bleed backdrop would sit on
// top of it as a slab. Presentation attributes lose to the class rule, so the
// rect has to go rather than be overridden.
export function dropBackgroundRect(svg: string): { svg: string; dropped: boolean } {
  const re = /(<svg\b[^>]*class="[^"]*d2-svg[^"]*"[^>]*>)\s*<rect\b[^>]*class="[^"]*fill-N7[^"]*"[^>]*\/>/;
  if (!re.test(svg)) return { svg, dropped: false };
  return { svg: svg.replace(re, "$1"), dropped: true };
}

// CommonMark ends a raw-HTML block at a blank line and reads tab-indented text
// as a code block, so d2's own stylesheet formatting destroys any figure inlined
// into markdown. Neither blank lines nor leading indentation mean anything in
// SVG or CSS, and d2 never wraps text content across lines.
export function flattenForMarkdown(svg: string): string {
  return svg
    .split("\n")
    .map((line) => line.replace(/^[\t ]+/, ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
}

export function applyHouseAttributes(svg: string, ariaLabel: string): string {
  const open = svg.match(/^<svg\b[^>]*>/);
  if (!open) throw new SvgError("output does not start with an <svg> tag");
  let tag = open[0];
  if (/\bwidth=/.test(tag)) tag = tag.replace(/\s*\bwidth="[^"]*"/, "");
  if (/\bheight=/.test(tag)) tag = tag.replace(/\s*\bheight="[^"]*"/, "");
  const escaped = ariaLabel.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  tag = tag.replace(
    /^<svg\b/,
    `<svg class="d2" role="img" aria-label="${escaped}" width="100%" style="height:auto"`,
  );
  return `<!-- ${SOURCE_MARK} -->\n${tag}${svg.slice(open[0].length)}`;
}

// Ink for a re-inlined monochrome mark. No single grey clears 3:1 against both
// the dark and the light node fill, which is why one baked colour cannot work
// and the mark has to follow the theme instead.
export const MONO_INK_LIGHT = "#3f3f46";
export const MONO_INK_DARK = "#e4e4e7";

const IMAGE_RE = /<image\b[^>]*?\/>/g;
const ATTR_RE = /\b(x|y|width|height)="([^"]*)"/g;
const HREF_RE = /\b(?:xlink:)?href="(data:image\/svg\+xml;base64,([^"]+))"/;

function innerMarkup(raw: string): { inner: string; viewBox: string } | null {
  const icon = raw.trim();
  const open = icon.match(/<svg\b[^>]*>/);
  if (!open || !icon.endsWith("</svg>")) return null;
  const viewBox = open[0].match(/\bviewBox="([^"]*)"/)?.[1];
  if (!viewBox) return null;
  return { inner: icon.slice(open[0].length, -"</svg>".length), viewBox };
}

// A monochrome pack is baked to one fill at vendor time because currentColor has
// nothing to inherit from inside a data: URI. Re-inlining the mark as a real
// <svg> puts it back under CSS, so the page theme drives its ink — otherwise an
// author has to paint a plate behind it, and a plate cannot follow the theme.
export function inlineMonochromeIcons(
  svg: string,
  fills: string[],
  prefix = 'html:not([data-theme="light"])',
): { svg: string; converted: number } {
  if (fills.length === 0) return { svg, converted: 0 };
  let converted = 0;
  const out = svg.replace(IMAGE_RE, (tag) => {
    const href = tag.match(HREF_RE);
    if (!href) return tag;
    let icon: string;
    try {
      const raw = atob(href[2]);
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      icon = new TextDecoder().decode(bytes);
    } catch {
      return tag;
    }
    const hit = fills.filter((f) => icon.includes(f));
    if (hit.length === 0) return tag;
    const parts = innerMarkup(icon);
    if (!parts) throw new SvgError("monochrome icon is not a single <svg> with a viewBox");
    let inner = parts.inner;
    for (const f of hit) inner = inner.replaceAll(f, "currentColor");
    const geom: Record<string, string> = {};
    for (const m of tag.matchAll(ATTR_RE)) geom[m[1]] = m[2];
    converted += 1;
    const attrs = ["x", "y", "width", "height"]
      .filter((k) => geom[k] !== undefined)
      .map((k) => `${k}="${geom[k]}"`)
      .join(" ");
    return `<svg class="d2-mono" ${attrs} viewBox="${parts.viewBox}" overflow="visible">${inner}</svg>`;
  });
  if (converted === 0) return { svg, converted };
  const rules = `.d2-mono{color:${MONO_INK_LIGHT};}${prefix} .d2-mono{color:${MONO_INK_DARK};}`;
  const root = out.match(/<svg\b[^>]*>/);
  if (!root) throw new SvgError("cannot attach monochrome ink rules — no <svg> root");
  const at = out.indexOf(root[0]) + root[0].length;
  return { svg: `${out.slice(0, at)}<style>${rules}</style>${out.slice(at)}`, converted };
}

export interface Containment {
  externalUrls: string[];
  scripts: number;
  foreignObjects: number;
  dataUriImages: number;
  imageRefs: number;
}

export function inspect(svg: string): Containment {
  const urls = [...svg.matchAll(URL_RE)].map((m) => m[0]).filter((u) => !ALLOWED_URLS.has(u));
  const hrefs = [...svg.matchAll(/(?:xlink:)?href="([^"]*)"/g)].map((m) => m[1]);
  return {
    externalUrls: [...new Set(urls)],
    scripts: (svg.match(/<script\b/g) ?? []).length,
    foreignObjects: (svg.match(/<foreignObject\b/g) ?? []).length,
    dataUriImages: hrefs.filter((h) => h.startsWith("data:")).length,
    imageRefs: hrefs.length,
  };
}

export function verifySelfContained(svg: string, expectedIcons: number): void {
  const found = inspect(svg);
  const problems: string[] = [];
  if (found.externalUrls.length > 0) {
    problems.push(`external references: ${found.externalUrls.slice(0, 5).join(", ")}`);
  }
  if (found.scripts > 0) problems.push(`${found.scripts} <script> element(s)`);
  if (found.foreignObjects > 0) problems.push(`${found.foreignObjects} <foreignObject> element(s)`);
  const nonData = found.imageRefs - found.dataUriImages;
  if (nonData > 0) problems.push(`${nonData} href(s) not inlined as data: URIs`);
  if (expectedIcons > 0 && found.dataUriImages < expectedIcons) {
    problems.push(`expected ${expectedIcons} embedded icon(s), found ${found.dataUriImages}`);
  }
  if (problems.length > 0) {
    throw new SvgError(
      `render is not self-contained — ${problems.join("; ")}. `
        + "The SVG must carry every asset inline; re-render with d2 --bundle (the default).",
    );
  }
}
