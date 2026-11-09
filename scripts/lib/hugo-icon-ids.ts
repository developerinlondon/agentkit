// Iconify ids repeat across logos and a logo can be drawn twice on one page, so every id
// carries the placeholder the Hugo diagrams module replaces with a per-drawn-icon prefix.
const PLACEHOLDER = "__DGI__";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A reference is `url(#id)` in any quoting (', ", &quot;, spaces inside the parentheses)
// or a whole-value `href="#id"` / `href='#id'`.
const QUOTE = `(?:'|"|&quot;)?`;

export function placeholderIds(body: string): string {
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  let out = body;
  for (const id of ids) {
    const esc = escape(id);
    out = out
      .replace(new RegExp(`(\\sid=")${esc}"`, "g"), `$1${PLACEHOLDER}${id}"`)
      .replace(new RegExp(`url\\(\\s*(${QUOTE})#${esc}(${QUOTE})\\s*\\)`, "g"), `url($1#${PLACEHOLDER}${id}$2)`)
      .replace(new RegExp(`(href=(['"]))#${esc}\\2`, "g"), `$1#${PLACEHOLDER}${id}$2`);
  }
  const loose = out.match(new RegExp(`url\\(\\s*${QUOTE}#(?!${PLACEHOLDER})[^)'"&\\s]+|href=['"]#(?!${PLACEHOLDER})[^'"]+`));
  if (loose) throw new Error(`reference ${loose[0]} has no id in the same icon, or one the rewrite missed`);
  return out;
}
