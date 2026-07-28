import { describe, expect, test } from 'bun:test';
import {
  applyHouseAttributes,
  dropBackgroundRect,
  inspect,
  retargetDarkTheme,
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
  test('the root is made fluid, labelled, and marked as d2-sourced', () => {
    const out = applyHouseAttributes('<svg width="300" height="400" viewBox="0 0 300 400"></svg>', 'a topology');
    expect(out).toContain('svg-source:d2');
    expect(out).toContain('class="d2"');
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="a topology"');
    expect(out).toContain('width="100%" style="height:auto"');
    expect(out).toContain('viewBox="0 0 300 400"');
    // Authored width/height would out-rank the theme's scale-to-fit backstop.
    expect(out).not.toContain('width="300"');
    expect(out).not.toContain('height="400"');
  });

  test('a label carrying markup cannot break out of the attribute', () => {
    const out = applyHouseAttributes('<svg viewBox="0 0 1 1"></svg>', 'a "quoted" <tag> & more');
    expect(out).toContain('aria-label="a &quot;quoted&quot; &lt;tag> &amp; more"');
  });

  test('input that is not an svg is refused', () => {
    expect(() => applyHouseAttributes('<html></html>', 'x')).toThrow(SvgError);
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
