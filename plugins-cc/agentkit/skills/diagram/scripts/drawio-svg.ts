// Post-processing and source screening for draw.io SVG output.

import { HOUSE_STYLE, naturalSize, SvgError } from "./d2-svg.ts";

export const DRAWIO_PIN = "31.3.2";
export const SOURCE_MARK = "svg-source:drawio";

// draw.io writes an XML prolog and a DOCTYPE pointing at the SVG 1.1 DTD. The
// DTD is an external identifier the containment check reads as a network
// reference, and neither survives being inlined into an HTML document anyway.
const PROLOG_RE = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?/;

// The plate the figure paints for itself. draw.io's dark theme remaps every
// authored colour, brand fills included, and the register forbids recolouring
// vendor artwork — so the figure is exported light-only and carries its own
// surface rather than borrowing the island's, which is dark on a dark page.
export const PLATE = "#ffffff";

export function stripPrologue(svg: string): string {
  const out = svg.replace(PROLOG_RE, "");
  if (!out.startsWith("<svg")) throw new SvgError("output does not start with an <svg> tag");
  return out;
}

// A `--theme light` export still declares `color-scheme: light dark`, which
// leaves the viewer's own UA styles free to reinterpret the figure.
export function plateBackground(svg: string, fill = PLATE): string {
  const root = svg.match(/^<svg\b[^>]*>/);
  if (!root) throw new SvgError("cannot attach the plate — no <svg> root");
  const box = root[0].match(/\bviewBox="([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+)"/);
  if (!box) throw new SvgError("cannot attach the plate — no viewBox on the rendered SVG");
  const [, x, y, w, h] = box;
  const tag = root[0].replace(/\s*color-scheme:\s*[^;"]*;?/, "");
  const rect = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  return tag + rect + svg.slice(root[0].length);
}

export function applyHouseAttributes(svg: string, ariaLabel: string): string {
  const open = svg.match(/^<svg\b[^>]*>/);
  if (!open) throw new SvgError("output does not start with an <svg> tag");
  let tag = open[0];
  // draw.io's own root style only paints a transparent backdrop, which the
  // figure island already supplies; left in place it becomes a second style
  // attribute on the tag and the house sizing silently loses to it.
  const { width, height } = naturalSize(tag);
  tag = tag.replace(/\s*\bwidth="[^"]*"/, "").replace(/\s*\bheight="[^"]*"/, "")
    .replace(/\s*\bstyle="[^"]*"/, "");
  const escaped = ariaLabel.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll(
    "<",
    "&lt;",
  );
  tag = tag.replace(
    /^<svg\b/,
    `<svg class="drawio" role="img" aria-label="${escaped}" width="${width}" height="${height}" style="${HOUSE_STYLE}"`,
  );
  return `<!-- ${SOURCE_MARK} -->\n${tag}${svg.slice(open[0].length)}`;
}

// draw.io salts gradient ids with a fresh nanoid per render and emits mxCell ids
// verbatim, so a figure ships `id="0"`. The salt churns the diff on every
// re-render; `0` collides with the page, and with a second draw.io figure whose
// cells are numbered from 0 too. One namespace per figure fixes both.
const GENERATED_PREFIX = /drawio-svg-[A-Za-z0-9_-]{20}-/g;
const ID_RE = /\bid="([^"]*)"/g;
// draw.io writes a paint server twice — once as fill="url(#x)" and once inside
// style= as url(&quot;#x&quot;), which is the one CSS actually honours. Missing
// either spelling leaves the shape unpainted with nothing else out of place.
const REF_RE = /url\(\s*(&quot;|&#39;|["'])?#([^)"'&\s]+)\1?\s*\)/g;
const HREF_RE = /((?:xlink:)?href)="#([^"]+)"/g;

export function namespaceIds(svg: string, salt: string): string {
  // A salt carrying a quote produces id="a"b-0", which ID_RE and REF_RE both
  // read as ending at the quote — so the containment check cannot see the very
  // breakage it exists to catch. Refusing the salt is what closes that.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(salt)) {
    throw new SvgError(`salt ${JSON.stringify(salt)} is not a slug — run it through saltFor first`);
  }
  const stripped = svg.replace(GENERATED_PREFIX, "");
  const ids = new Set([...stripped.matchAll(ID_RE)].map((m) => m[1]).filter(Boolean));
  for (const id of ids) {
    // An upstream change to the salt format would render fine and churn forever.
    if (id.includes("drawio-svg-")) {
      throw new SvgError(`generated id "${id}" did not match the salt draw.io v${DRAWIO_PIN} writes`);
    }
  }
  const rename = (name: string): string => ids.has(name) ? `${salt}-${name}` : name;
  const out = stripped
    .replace(ID_RE, (_m, id: string) => `id="${rename(id)}"`)
    .replace(REF_RE, (_m, q: string | undefined, name: string) => `url(${q ?? ""}#${rename(name)}${q ?? ""})`)
    .replace(HREF_RE, (_m, attr: string, name: string) => `${attr}="#${rename(name)}"`);
  verifyReferences(out);
  return out;
}

// The escaped spelling above was missed once and both gradient-filled stencils
// silently disappeared, so resolution is checked rather than assumed.
export function verifyReferences(svg: string): void {
  const ids = new Set([...svg.matchAll(ID_RE)].map((m) => m[1]));
  const refs = [
    ...[...svg.matchAll(REF_RE)].map((m) => m[2]),
    ...[...svg.matchAll(HREF_RE)].map((m) => m[2]),
  ];
  const dangling = [...new Set(refs.filter((r) => !ids.has(r)))];
  if (dangling.length > 0) {
    throw new SvgError(
      `render references ${dangling.length} id(s) it does not define: ${dangling.slice(0, 5).join(", ")}`,
    );
  }
}

// Every salt goes through this, an explicit --salt included: it lands inside an
// id attribute and a url() reference, so a quote in it would close the attribute
// and produce markup no gate downstream inspects.
export function saltFor(name: string): string {
  const slug = name.replace(/\.svg$/, "").replaceAll(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug === "" ? "drawio" : slug.toLowerCase();
}

// Every label style that reaches the HTML renderer exports as a <foreignObject>
// beside a base64 raster twin and a link to drawio.com — 7x the bytes, and an
// external URL the containment gate refuses. Screened in the source rather than
// the output, which reports the count but never which cell caused it.
const LABEL_TRAPS: Array<{ token: RegExp; fix: string }> = [
  { token: /\bhtml=1\b/, fix: "html=1 → html=0" },
  { token: /\bwhiteSpace=wrap\b/, fix: "drop whiteSpace=wrap and shorten the label" },
  { token: /\boverflow=(?:fill|width)\b/, fix: "drop overflow=fill/width" },
];

export interface SourceProblem {
  cellId: string;
  fix: string;
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

export function screenSource(xml: string): SourceProblem[] {
  const problems: SourceProblem[] = [];
  for (const m of xml.matchAll(/<(?:mxCell|object|UserObject)\b[^>]*>/g)) {
    const style = attribute(m[0], "style");
    if (style === undefined) continue;
    const id = attribute(m[0], "id") ?? "(unnamed cell)";
    for (const trap of LABEL_TRAPS) {
      if (trap.token.test(style)) problems.push({ cellId: id, fix: trap.fix });
    }
  }
  return problems;
}

// A .drawio page may carry its diagram as deflate+base64 rather than as XML, in
// which case the style screen above sees nothing and passes a page it never
// read. Every page is checked, not just the first: a file whose second page is
// compressed would otherwise reach the renderer unscreened.
export function compressedPages(xml: string): string[] {
  const pages: string[] = [];
  let index = 0;
  for (const m of xml.matchAll(/<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g)) {
    index += 1;
    if (/<mxGraphModel\b/.test(m[2])) continue;
    const name = m[1].match(/\bname="([^"]*)"/)?.[1];
    pages.push(name ? `${index} (${name})` : `${index}`);
  }
  return pages;
}
