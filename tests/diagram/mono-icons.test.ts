import { describe, expect, test } from 'bun:test';
import {
  flattenForMarkdown,
  inlineMonochromeIcons,
  MONO_INK_DARK,
  MONO_INK_LIGHT,
  SvgError,
} from '../../skills/diagram/scripts/d2-svg.ts';
import { monochromeFills, searchIcons } from '../../skills/diagram/scripts/icons.ts';

const FILL = '#71717a';

// d2's own container fill (fill-B6) in each palette — what a re-inked mark is
// actually read against.
const D2_NODE_LIGHT = '#F7F8FE';
const D2_NODE_DARK = '#313244';

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    const ch = [0, 2, 4].map((i) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function image(icon: string, geom = 'x="10" y="20" width="64" height="64"'): string {
  const b64 = btoa(icon);
  return `<svg class="d2"><image href="data:image/svg+xml;base64,${b64}" ${geom} /></svg>`;
}

const MONO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path fill="${FILL}" d="M1 2"/></svg>`;
const COLOUR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#3178c6" d="M1 2"/></svg>';

describe('monochrome icon re-inlining', () => {
  test('a baked monochrome mark becomes an inline svg driven by currentColor', () => {
    // Baked to one grey at vendor time, it cannot clear contrast on both the
    // dark and the light node fill; only CSS can resolve that per theme.
    const out = inlineMonochromeIcons(image(MONO), [FILL], [MONO]);
    expect(out.converted).toBe(1);
    expect(out.svg).toContain('<svg class="d2-mono"');
    expect(out.svg).toContain('fill="currentColor"');
    expect(out.svg).not.toContain(FILL);
    expect(out.svg).not.toContain('<image');
  });

  test('geometry and viewBox survive the swap', () => {
    const out = inlineMonochromeIcons(image(MONO), [FILL], [MONO]);
    expect(out.svg).toContain('x="10"');
    expect(out.svg).toContain('y="20"');
    expect(out.svg).toContain('width="64"');
    expect(out.svg).toContain('height="64"');
    expect(out.svg).toContain('viewBox="0 0 24 24"');
  });

  test('ink is themed, defaulting to the light rendering when no page theme applies', () => {
    const out = inlineMonochromeIcons(image(MONO), [FILL], [MONO]);
    expect(out.svg).toContain(`.d2-mono{color:${MONO_INK_LIGHT};}`);
    expect(out.svg).toContain(`html:not([data-theme="light"]) .d2-mono{color:${MONO_INK_DARK};}`);
  });

  test('each ink clears 4.5:1 on the node fill it is rendered against', () => {
    // Asserting the constant against itself passes even when both inks are
    // identical, which collapses one theme to 1.2:1 — the exact failure the
    // feature exists to prevent. These are d2's own container fills (fill-B6).
    expect(contrast(MONO_INK_LIGHT, D2_NODE_LIGHT)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(MONO_INK_DARK, D2_NODE_DARK)).toBeGreaterThanOrEqual(4.5);
  });

  test('the two inks are not interchangeable', () => {
    expect(contrast(MONO_INK_LIGHT, D2_NODE_DARK)).toBeLessThan(4.5);
    expect(contrast(MONO_INK_DARK, D2_NODE_LIGHT)).toBeLessThan(4.5);
  });

  test('full-colour brand artwork is left byte-for-byte alone', () => {
    // The trademark rule: only single-colour marks are re-inked.
    const before = image(COLOUR);
    const out = inlineMonochromeIcons(before, [FILL]);
    expect(out.converted).toBe(0);
    expect(out.svg).toBe(before);
  });

  test('a mixed render converts only the monochrome mark', () => {
    const mixed = `<svg class="d2">${image(MONO).slice('<svg class="d2">'.length, -'</svg>'.length)}${
      image(COLOUR).slice('<svg class="d2">'.length, -'</svg>'.length)
    }</svg>`;
    const out = inlineMonochromeIcons(mixed, [FILL], [MONO]);
    expect(out.converted).toBe(1);
    expect(out.svg).toContain('<image');
    expect(out.svg).toContain('class="d2-mono"');
  });

  test('no fills configured is a no-op rather than a scan', () => {
    const before = image(MONO);
    expect(inlineMonochromeIcons(before, [], [MONO])).toEqual({ svg: before, converted: 0 });
  });

  test('a payload with an XML prolog or generator comment is refused, not sliced blind', () => {
    // Slicing by the matched tag's LENGTH rather than its INDEX left the
    // preamble inside the element as stray text and nested a second root.
    const prolog = `<?xml version="1.0"?><!-- Generator: Illustrator -->`
      + `<svg viewBox="0 0 18 18"><path fill="${FILL}" d="M9 1"/></svg>`;
    expect(() => inlineMonochromeIcons(image(prolog), [FILL], [prolog])).toThrow(SvgError);
  });

  test('a payload with two concatenated roots is refused', () => {
    const two = `<svg viewBox="0 0 8 8"><path fill="${FILL}" d="M1 1"/></svg>`
      + `<svg viewBox="0 0 8 8"><path fill="${FILL}" d="M2 2"/></svg>`;
    expect(() => inlineMonochromeIcons(image(two), [FILL], [two])).toThrow(SvgError);
  });

  test('the fill is re-inked in colour attributes only, never in ids or text', () => {
    const tricky = `<svg viewBox="0 0 24 24"><path fill="${FILL}" stroke="${FILL}" d="M1 2"/>`
      + `<text>${FILL}</text><g id="${FILL}-grp"/></svg>`;
    const out = inlineMonochromeIcons(image(tricky), [FILL], [tricky]);
    expect(out.svg).toContain('fill="currentColor"');
    expect(out.svg).toContain('stroke="currentColor"');
    expect(out.svg).toContain(`<text>${FILL}</text>`);
    expect(out.svg).toContain(`id="${FILL}-grp"`);
  });

  test('a fill that is a prefix of another does not corrupt the longer one', () => {
    // Anchoring on the whole attribute value makes the prefix class impossible;
    // a substring replace turned fill="#71717a" into fill="currentColor17a".
    const doc = `<svg viewBox="0 0 24 24"><path fill="#717" d="M1 2"/><path fill="${FILL}" d="M3 4"/></svg>`;
    const out = inlineMonochromeIcons(image(doc), ['#717', FILL], [doc]);
    expect(out.svg).not.toContain('currentColor17a');
    expect(out.svg.match(/currentColor/g)).toHaveLength(2);
  });

  test('only marks from a monochrome pack are re-inked when sources are known', () => {
    // Brand artwork that merely contains the baked hex is not a monochrome mark.
    const brandArt = `<svg viewBox="0 0 24 24"><path fill="${FILL}" d="M3 4"/></svg>`;
    const known = `<svg viewBox="0 0 24 24"><path fill="${FILL}" d="M1 2"/></svg>`;
    expect(inlineMonochromeIcons(image(brandArt), [FILL], [known]).converted).toBe(0);
    expect(inlineMonochromeIcons(image(known), [FILL], [known]).converted).toBe(1);
  });

  test('a monochrome payload that is not a single viewBoxed svg fails loudly', () => {
    const headless = `<g><path fill="${FILL}" d="M1 2"/></g>`;
    expect(() => inlineMonochromeIcons(image(headless), [FILL], [headless])).toThrow(SvgError);
  });
});

describe('icon discovery', () => {
  test('the baked monochrome fill is read from the selection, not hardcoded twice', () => {
    expect(monochromeFills()).toContain(FILL);
  });

  test('search reports the set and whether a hit is monochrome', () => {
    const hits = searchIcons('traefik');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].key).toBe('traefikproxy');
    expect(hits[0].monochrome).toBe(true);
  });

  test('full-colour packs are not reported as monochrome', () => {
    const hits = searchIcons('postgres');
    expect(hits.every((h) => h.monochrome === false)).toBe(true);
  });

  test('a mark no vendored pack carries returns nothing rather than a near-miss', () => {
    // No CC0 pack vendored here carries a traefik mark; a look-alike from
    // another vendor would be worse than an honest miss.
    expect(searchIcons('zzzznotarealmark')).toEqual([]);
  });
});

describe('markdown-safe flattening', () => {
  test('blank lines and leading indentation are removed', () => {
    // CommonMark ends a raw-HTML block at a blank line and reads tab-indented
    // text as a code block, so d2's own formatting destroys an inlined figure.
    const out = flattenForMarkdown('<svg>\n\n\t\t<style>.a{fill:red}</style>\n    <g/>\n</svg>');
    expect(out.split('\n').some((l) => l.trim() === '')).toBe(false);
    expect(out.split('\n').some((l) => /^[\t ]/.test(l))).toBe(false);
    expect(out).toContain('<style>.a{fill:red}</style>');
    expect(out).toContain('<g/>');
  });

  test('markup is preserved verbatim apart from that whitespace', () => {
    const out = flattenForMarkdown('<svg>\n  <text>keep  inner  spaces</text>\n</svg>');
    expect(out).toBe('<svg>\n<text>keep  inner  spaces</text>\n</svg>');
  });

  test('an already-flat svg is unchanged', () => {
    const flat = '<svg>\n<g/>\n</svg>';
    expect(flattenForMarkdown(flat)).toBe(flat);
  });
});

describe('conversion post-conditions', () => {
  const shapes: ReadonlyArray<readonly [string, string]> = [
    ['a style attribute', `<svg viewBox="0 0 24 24"><path style="fill:${FILL}" d="M0 0"/></svg>`],
    ['a CSS class', `<svg viewBox="0 0 24 24"><style>.c{fill:${FILL}}</style><path class="c"/></svg>`],
    ['the root tag', `<svg viewBox="0 0 24 24" fill="${FILL}"><path d="M0 0"/></svg>`],
  ];

  for (const [how, doc] of shapes) {
    test(`a mark coloured by ${how} fails instead of shipping unthemed`, () => {
      // Only presentation attributes are inked, so these convert with the baked
      // colour intact — reporting success while the mark cannot follow the theme.
      expect(() => inlineMonochromeIcons(image(doc), [FILL], [doc])).toThrow(SvgError);
    });
  }

  test('an unstaged icon is treated as full-colour, never sniffed for the baked hex', () => {
    // A diagram staging no monochrome asset must not fall back to a substring
    // test over brand artwork that happens to contain the same colour.
    const brandArt = `<svg viewBox="0 0 24 24"><path fill="#0078D4" d="M1 1"/><path fill="${FILL}" d="M2 2"/></svg>`;
    const before = image(brandArt);
    const out = inlineMonochromeIcons(before, [FILL], []);
    expect(out.converted).toBe(0);
    expect(out.svg).toBe(before);
  });
});

describe('the post-condition checks colour positions, not the token', () => {
  const mixed: ReadonlyArray<readonly [string, string]> = [
    ['a style= sibling', `<svg viewBox="0 0 24 24"><path fill="${FILL}"/><path style="fill:${FILL}"/></svg>`],
    ['a CSS-class sibling', `<svg viewBox="0 0 24 24"><style>.c{fill:${FILL}}</style><path fill="${FILL}"/><path class="c"/></svg>`],
    ['currentColor only in a desc', `<svg viewBox="0 0 24 24"><desc>uses currentColor</desc><path style="fill:${FILL}"/></svg>`],
    ['currentColor only as an id', `<svg viewBox="0 0 24 24"><style>.c{fill:${FILL}}</style><g id="currentColor"/><path class="c"/></svg>`],
  ];

  for (const [how, doc] of mixed) {
    test(`a mark inking one element and baking another via ${how} fails`, () => {
      // `includes("currentColor")` asks whether anything was inked, not whether
      // everything was — and the token appears in prose and in ids too.
      expect(() => inlineMonochromeIcons(image(doc), [FILL], [doc])).toThrow(SvgError);
    });
  }
});

describe('colour notation', () => {
  const RGB = 'rgb(113,113,122)';

  test('the same colour written as rgb() in an attribute is inked too', () => {
    const doc = `<svg viewBox="0 0 24 24"><path fill="${FILL}"/><path fill="${RGB}"/></svg>`;
    const out = inlineMonochromeIcons(image(doc), [FILL], [doc]);
    expect(out.converted).toBe(1);
    expect(out.svg).not.toContain(RGB);
  });

  for (const [how, css] of [['a CSS block', RGB], ['spacing', 'rgb(113, 113, 122)']] as const) {
    test(`rgb() with ${how} is caught by the post-condition, not shipped baked`, () => {
      const doc = `<svg viewBox="0 0 24 24"><path fill="${FILL}"/><style>.c{fill:${css}}</style><path class="c"/></svg>`;
      expect(() => inlineMonochromeIcons(image(doc), [FILL], [doc])).toThrow(SvgError);
    });
  }

  test('the hex in a text node is left alone — it renders nothing', () => {
    const doc = `<svg viewBox="0 0 24 24"><desc>${FILL}</desc><path fill="${FILL}" d="M1 1"/></svg>`;
    expect(inlineMonochromeIcons(image(doc), [FILL], [doc]).converted).toBe(1);
  });
});
