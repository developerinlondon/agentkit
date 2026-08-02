// `:first-child` counts elements, so CSS cannot tell a callout's label from a
// bold phrase that is merely the first ELEMENT in a sentence — the text before
// it is invisible to the selector. Only document order including text answers
// it, so the label is marked here and the theme styles the mark.
const LEADING_BOLD = /(<div\b[^>]*>\s*(?:<p>\s*)?)<(strong|h3)((?:\s[^>]*)?)>/gi;
const CLASS_ATTRIBUTE = /(\bclass\s*=\s*)(["'])(.*?)\2/i;

function classes(tag: string): string[] {
  return CLASS_ATTRIBUTE.exec(tag)?.[3].split(/\s+/).filter(Boolean) ?? [];
}

export function markCalloutLabels(html: string): string {
  return html.replace(LEADING_BOLD, (whole, head: string, tag: string, attrs: string) => {
    const openingDiv = head.match(/^<div\b[^>]*>/i)?.[0] ?? "";
    if (!classes(openingDiv).includes("callout")) return whole;
    if (classes(`<${tag}${attrs}>`).includes("callout-label")) return whole;
    const marked = CLASS_ATTRIBUTE.test(attrs)
      ? attrs.replace(
        CLASS_ATTRIBUTE,
        (_attribute, prefix: string, quote: string, value: string) =>
          `${prefix}${quote}callout-label ${value}${quote}`,
      )
      : `${attrs} class="callout-label"`;
    return `${head}<${tag}${marked}>`;
  });
}
