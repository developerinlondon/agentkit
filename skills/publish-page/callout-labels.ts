// `:first-child` counts elements, so CSS cannot tell a callout's label from a
// bold phrase that is merely the first ELEMENT in a sentence — the text before
// it is invisible to the selector. Only document order including text answers
// it, so the label is marked here and the theme styles the mark.
const LEADING_BOLD = /(<div class="callout[^"]*">\s*(?:<p>\s*)?)<(strong|h3)((?:\s[^>]*)?)>/g;

export function markCalloutLabels(html: string): string {
  return html.replace(LEADING_BOLD, (_whole, head: string, tag: string, attrs: string) => {
    const marked = /\bclass="/.test(attrs)
      ? attrs.replace(/\bclass="/, 'class="callout-label ')
      : `${attrs} class="callout-label"`;
    return `${head}<${tag}${marked}>`;
  });
}
