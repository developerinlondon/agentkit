import { describe, expect, test } from 'bun:test';
import {
  applyHouseAttributes,
  dropBackgroundRect,
  inspect,
  retargetDarkTheme,
  scopeElementRules,
  stripHouseCap,
  SvgError,
  verifySelfContained,
} from '../../skills/diagram/scripts/d2-svg.ts';

const DARK_BLOCK = '@media screen and (prefers-color-scheme:dark){.d2-1 .fill-N1{fill:#CDD6F4;}}';

describe('d2 dark-palette retargeting', () => {
  test('the OS-preference guard becomes the page theme attribute', () => {
    // d2 gates its dark palette on prefers-color-scheme, which ignores the
    // page's own toggle; a diagram would then contradict the theme around it.
    const out = retargetDarkTheme(`<svg><style>${DARK_BLOCK}</style></svg>`);
    expect(out).not.toContain('prefers-color-scheme');
    expect(out).toContain('html:not([data-theme="light"]) .d2-1 .fill-N1{fill:#CDD6F4;}');
  });

  test('every selector in a comma-separated rule is guarded, not just the first', () => {
    const block = '@media screen and (prefers-color-scheme:dark){.a,.b{fill:#111;}}';
    const out = retargetDarkTheme(`<svg><style>${block}</style></svg>`);
    expect(out).toContain('html:not([data-theme="light"]) .a,html:not([data-theme="light"]) .b{fill:#111;}');
  });

  test('rules after the dark block survive the rewrite', () => {
    const out = retargetDarkTheme(`<svg><style>${DARK_BLOCK}.after{fill:#222;}</style></svg>`);
    expect(out).toContain('.after{fill:#222;}');
  });

  test('a single-palette render is passed through untouched', () => {
    const svg = '<svg><style>.d2-1 .fill-N1{fill:#000;}</style></svg>';
    expect(retargetDarkTheme(svg)).toBe(svg);
  });
});

describe('d2 element-rule scoping', () => {
  // d2 scopes colour classes under the figure's own carrier but ships .shape,
  // .md and friends bare, so an inlined figure redefines them page-wide.
  const svg = '<svg class="d2"><svg class="d2-1 d2-svg" viewBox="0 0 1 1">'
    + '<style type="text/css"><![CDATA['
    + '.shape{a:1;}.d2-1 .fill-N1{fill:red;}'
    + '@font-face{font-family:x;src:url(#y);}'
    + 'html:not([data-theme="light"]) .md{b:2;}'
    + 'html:not([data-theme="light"]) .d2-1 .fill-N1{fill:blue;}'
    + ']]></style></svg></svg>';

  test('a bare element rule is scoped under the figure carrier', () => {
    expect(scopeElementRules(svg)).toContain('.d2-1 .shape{a:1;}');
  });

  test('a rule already scoped is left alone, not double-prefixed', () => {
    const out = scopeElementRules(svg);
    expect(out).toContain('.d2-1 .fill-N1{fill:red;}');
    expect(out).not.toContain('.d2-1 .d2-1');
  });

  test('@font-face has no selector and is passed through untouched', () => {
    expect(scopeElementRules(svg)).toContain('@font-face{font-family:x;src:url(#y);}');
  });

  test('a dark-relocated bare rule is scoped after the theme guard, not before it', () => {
    // The guard targets <html>, which cannot be a descendant of the figure —
    // scoping in front would produce a selector that can never match.
    expect(scopeElementRules(svg)).toContain('html:not([data-theme="light"]) .d2-1 .md{b:2;}');
  });

  test('a dark-relocated rule already scoped keeps its order and is not doubled', () => {
    const out = scopeElementRules(svg);
    expect(out).toContain('html:not([data-theme="light"]) .d2-1 .fill-N1{fill:blue;}');
    expect(out).not.toContain('.d2-1 .d2-1');
  });

  test('a custom dark selector (--host class) is scoped the same way', () => {
    const classHost = svg.replaceAll('html:not([data-theme="light"])', 'html.dark');
    expect(scopeElementRules(classHost, 'html.dark')).toContain('html.dark .d2-1 .md{b:2;}');
  });

  test('with no scope carrier, the svg is passed through unchanged', () => {
    const plain = '<svg><style type="text/css"><![CDATA[.shape{a:1;}]]></style></svg>';
    expect(scopeElementRules(plain)).toBe(plain);
  });
});

describe('background rect removal', () => {
  const svg = '<svg class="d2-1 d2-svg" viewBox="0 0 10 10"><rect x="0" class=" fill-N7" stroke-width="0" /><g/></svg>';

  test('the full-bleed backdrop is removed so the figure island shows through', () => {
    const out = dropBackgroundRect(svg);
    expect(out.dropped).toBe(true);
    expect(out.svg).not.toContain('fill-N7');
    expect(out.svg).toContain('<g/>');
  });

  test('an unrecognised shape reports failure instead of silently mangling it', () => {
    const out = dropBackgroundRect('<svg><g/></svg>');
    expect(out.dropped).toBe(false);
    expect(out.svg).toBe('<svg><g/></svg>');
  });
});

describe('house attributes', () => {
  test('the root is sized, capped, labelled, and marked as d2-sourced', () => {
    const out = applyHouseAttributes('<svg width="300" height="400" viewBox="0 0 300 400"></svg>', 'a topology');
    expect(out).toContain('svg-source:d2');
    expect(out).toContain('class="d2"');
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="a topology"');
    expect(out).toContain('width="300" height="400" style="max-width:100%;height:auto"');
    expect(out).toContain('viewBox="0 0 300 400"');
    // width="100%" is what upscaled every figure narrower than the column.
    expect(out).not.toContain('100%"');
  });

  test('the natural size comes from the viewBox, not from the authored attributes', () => {
    // d2 writes a percentage width on some exports and the raster twin is sized
    // off the viewBox, so the viewBox is the one measurement worth trusting.
    const out = applyHouseAttributes('<svg width="100%" viewBox="0 0 757.2 1331.4"></svg>', 'x');
    expect(out).toContain('width="758" height="1332"');
  });

  test('a root with no viewBox is refused rather than shipped unsized', () => {
    expect(() => applyHouseAttributes('<svg width="300" height="400"></svg>', 'x')).toThrow(SvgError);
  });

  test('the raster twin strips exactly the cap the house root wrote', () => {
    // The two must stay in step: a raster taken under the cap shrinks to the
    // screenshot viewport instead of showing the figure at natural size.
    const shipped = applyHouseAttributes('<svg viewBox="0 0 300 400"></svg>', 'a topology');
    const raster = stripHouseCap(shipped);
    expect(raster).not.toContain('max-width');
    expect(raster).not.toContain('style=');
    expect(raster).toContain('width="300" height="400"');
    expect(raster).toContain('aria-label="a topology"');
  });

  test('a declaration the renderer set beside the cap survives the strip', () => {
    const out = stripHouseCap('<svg style="color:red;max-width:100%;height:auto" viewBox="0 0 1 1"/>');
    expect(out).toContain('style="color:red"');
  });

  test('a root carrying no cap is returned untouched', () => {
    const raw = '<svg width="10" height="20" viewBox="0 0 10 20"/>';
    expect(stripHouseCap(raw)).toBe(raw);
  });

  test('a label carrying markup cannot break out of the attribute', () => {
    const out = applyHouseAttributes('<svg viewBox="0 0 1 1"></svg>', 'a "quoted" <tag> & more');
    expect(out).toContain('aria-label="a &quot;quoted&quot; &lt;tag> &amp; more"');
  });

  test('input that is not an svg is refused', () => {
    expect(() => applyHouseAttributes('<html></html>', 'x')).toThrow(SvgError);
  });

  test('a root style the renderer already set is merged, not duplicated', () => {
    // d2 writes no root style today, so this is the contract the shared helper
    // holds rather than a shape any current export produces.
    const out = applyHouseAttributes('<svg style="color:red" viewBox="0 0 10 20"></svg>', 'x');
    expect(out).toContain('style="color:red;max-width:100%;height:auto"');
    expect([...out.matchAll(/\bstyle="/g)]).toHaveLength(1);
  });
});

describe('self-containment verification', () => {
  const clean = '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,AAA"/></svg>';

  test('namespace declarations are not mistaken for network references', () => {
    expect(() => verifySelfContained(clean, 1)).not.toThrow();
    expect(inspect(clean).externalUrls).toEqual([]);
  });

  test('a remote image reference is refused', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://cdn.example.com/a.png"/></svg>';
    expect(() => verifySelfContained(svg, 1)).toThrow(/external references/);
  });

  test('a script element is refused', () => {
    expect(() => verifySelfContained(`${clean}<script>alert(1)</script>`, 1)).toThrow(/<script>/);
  });

  test('foreignObject is refused — d2 markdown blocks emit it and it does not travel', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>';
    expect(() => verifySelfContained(svg, 0)).toThrow(/foreignObject/);
  });

  test('a missing icon is caught even when nothing external is referenced', () => {
    // The failure this guards: d2 silently drops an icon it cannot read, and
    // the render looks fine until someone notices the logo is absent.
    expect(() => verifySelfContained(clean, 2)).toThrow(/expected 2 embedded icon/);
  });

  test('a local file path left in an href is refused', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="/home/u/icon.svg"/></svg>';
    expect(() => verifySelfContained(svg, 1)).toThrow(/not inlined as data: URIs/);
  });
});
