// `:first-child` counts elements, so CSS cannot tell a callout's label from a
// bold phrase that is merely the first ELEMENT in a sentence — the text before
// it is invisible to the selector. Only document order including text answers
// it, so the label is marked here and the theme styles the mark.
const LEADING_BOLD = /(<div\b[^>]*>\s*(?:<p>\s*)?)<(strong|h3)((?:\s[^>]*)?)>/gi;
// `\b` sits between the hyphen and the c, so a bare \bclass also matches
// data-class: the marker landed in the data attribute and the label rendered
// unstyled, and a div carrying only data-class="callout" was read as a callout.
const CLASS_ATTRIBUTE = /(^|\s)(class\s*=\s*)(["'])(.*?)\3/i;

function classes(tag: string): string[] {
  return CLASS_ATTRIBUTE.exec(tag)?.[4].split(/\s+/).filter(Boolean) ?? [];
}

export function markCalloutLabels(html: string): string {
  return html.replace(LEADING_BOLD, (whole, head: string, tag: string, attrs: string) => {
    const openingDiv = head.match(/^<div\b[^>]*>/i)?.[0] ?? "";
    if (!classes(openingDiv).includes("callout")) return whole;
    if (classes(`<${tag}${attrs}>`).includes("callout-label")) return whole;
    const marked = CLASS_ATTRIBUTE.test(attrs)
      ? attrs.replace(
        CLASS_ATTRIBUTE,
        (_attribute, lead: string, prefix: string, quote: string, value: string) =>
          `${lead}${prefix}${quote}callout-label ${value}${quote}`,
      )
      : `${attrs} class="callout-label"`;
    return `${head}<${tag}${marked}>`;
  });
}
