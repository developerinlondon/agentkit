// Rule-level reads of a theme's stylesheet, shared by the guards that resolve a
// cascade rather than match rule text.
export interface Rule {
  selectors: string;
  body: string;
}

export function styleBlocks(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// A nested at-rule's own brace breaks the selector arm, so the rules an @media
// block wraps come out as themselves rather than as one giant selector.
export function cssRules(html: string): Rule[] {
  return [...styleBlocks(html).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selectors: m[1].trim(), body: m[2] }));
}
