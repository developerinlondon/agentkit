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

// Ink for a re-inlined monochrome mark. Against the d2 node fills a single grey
// tops out near 3.9:1 and clears 4.5:1 on neither, so one baked colour cannot
// serve both themes and the mark has to follow the theme instead.
export const MONO_INK_LIGHT = "#3f3f46";
export const MONO_INK_DARK = "#e4e4e7";

const IMAGE_RE = /<image\b[^>]*?\/>/g;
const ATTR_RE = /\b(x|y|width|height)="([^"]*)"/g;
const HREF_RE = /\b(?:xlink:)?href="(data:image\/svg\+xml;base64,([^"]+))"/;

// Anchoring on the tag's index, not its length: a payload carrying an XML
// prolog or a generator comment starts its root later, and slicing by length
// leaves that preamble inside the element as stray text.
function innerMarkup(raw: string): { inner: string; viewBox: string } | null {
  const icon = raw.trim();
  const open = icon.match(/<svg\b[^>]*>/);
  if (!open || open.index === undefined || !icon.endsWith("</svg>")) return null;
  const viewBox = open[0].match(/\bviewBox="([^"]*)"/)?.[1];
  if (!viewBox) return null;
  const inner = icon.slice(open.index + open[0].length, -"</svg>".length);
  if (icon.slice(0, open.index).trim() !== "") return null;
  if (/<svg\b/.test(inner)) return null;
  return { inner, viewBox };
}

// The same colour can be written as a hex or as rgb(), and a pack that mixes
// notations would leave half the mark baked.
// #abc and #aabbccff are the same colour as #aabbcc; #aabbcc80 is not, and an
// alpha channel is carried through so it can be refused rather than flattened.
function hexKey(value: string): string | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 6) return `#${h}`;
  if (h.length !== 8) return null;
  return h.slice(6) === "ff" ? `#${h.slice(0, 6)}` : `#${h.slice(0, 6)}/${h.slice(6)}`;
}

// Normalised on both sides or not at all: expanding the painted value but not
// the registered fill stops a shorthand hex from matching itself.
function colourKeys(fill: string): string[] {
  const key = hexKey(fill.trim());
  if (key === null) return [fill.trim().toLowerCase()];
  const six = /^#([0-9a-f]{6})$/.exec(key);
  if (!six) return [key];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(six[1].slice(i, i + 2), 16));
  return [key, `${r},${g},${b}`];
}

// One colour has several spellings: CSS Color 4 writes `rgb(1 2 3)` beside
// `rgb(1,2,3)`. Comparing parsed channels rather than stripped text matches
// every spelling without letting two different colours collapse into one.
function valueKey(value: string): string {
  const v = value.trim().toLowerCase();
  const hex = hexKey(v);
  if (hex) return hex;
  const call = /^rgba?\(([^)]*)\)$/.exec(v);
  if (!call) return v.replace(/\s+/g, "");
  const parts = call[1].split(/[\s,/]+/).filter(Boolean);
  const channels = parts.slice(0, 3).join(",");
  const alpha = parts[3];
  if (!alpha || /^(?:1(?:\.0+)?|100(?:\.0+)?%)$/.test(alpha)) return channels;
  return `${channels}/${parts.slice(3).join(",")}`;
}

// Colour lives in a fill or stroke value; the same string elsewhere is an id, a
// class or label text, and rewriting it there corrupts the mark silently.
function inkAttributes(markup: string, fill: string): string {
  const keys = colourKeys(fill);
  return markup.replace(
    /\b(fill|stroke|stop-color|flood-color)="([^"]*)"/gi,
    (attribute, name: string, value: string) => {
      const key = valueKey(value);
      if (keys.some((opaque) => key.startsWith(`${opaque}/`))) {
        throw new SvgError("monochrome icon carries alpha-bearing ink, which cannot become opaque currentColor");
      }
      return keys.includes(key) ? `${name}="currentColor"` : attribute;
    },
  );
}

// Colour set in a style attribute or a CSS block is not reachable by attribute
// inking, so a mark using either keeps its baked value and cannot follow a theme.
function bakedInStyle(markup: string, fill: string): boolean {
  const styles = [...markup.matchAll(/style="([^"]*)"/gi)].map((m) => m[1]);
  const blocks = [...markup.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const keys = colourKeys(fill);
  return [...styles, ...blocks].some((css) => {
    const text = css.toLowerCase();
    // A substring scan read #71717a inside #71717a80, so the two paths
    // disagreed on the one notation each handled differently.
    const found = [
      ...[...text.matchAll(/#[0-9a-f]{3,8}\b/g)].map((m) => hexKey(m[0])),
      ...[...text.matchAll(/rgba?\([^)]*\)/g)].map((m) => valueKey(m[0])),
    ];
    return found.some((key) =>
      key !== null && keys.some((opaque) => key === opaque || key.startsWith(`${opaque}/`))
    );
  });
}

// A monochrome pack is baked to one fill at vendor time because currentColor has
// nothing to inherit from inside a data: URI. Re-inlining the mark as a real
// <svg> puts it back under CSS, so the page theme drives its ink.
// `sources` is the exact text of every staged monochrome asset: identity beats
// sniffing for the baked fill, which cannot tell a monochrome mark from brand
// artwork that merely contains the same hex.
export function inlineMonochromeIcons(
  svg: string,
  fills: string[],
  sources: string[] = [],
  prefix = 'html:not([data-theme="light"])',
): { svg: string; converted: number } {
  if (fills.length === 0 || sources.length === 0) return { svg, converted: 0 };
  const known = new Set(sources.map((s) => s.trim()));
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
    if (!known.has(icon.trim())) return tag;
    const parts = innerMarkup(icon);
    if (!parts) throw new SvgError("monochrome icon is not a single <svg> with a viewBox");
    let inner = parts.inner;
    for (const f of fills) inner = inkAttributes(inner, f);
    // currentColor alone proves nothing — it also appears in a <desc> or an id.
    if (fills.some((f) => bakedInStyle(inner, f))) {
      throw new SvgError("monochrome icon inks through style= or a CSS block, which cannot follow the theme");
    }
    if (!inner.includes("currentColor")) {
      throw new SvgError("monochrome icon carries no inkable fill — colour set by style, class or root tag");
    }
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
