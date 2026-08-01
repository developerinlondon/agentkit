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
    const out = inlineMonochromeIcons(image(MONO), [FILL]);
    expect(out.converted).toBe(1);
    expect(out.svg).toContain('<svg class="d2-mono"');
    expect(out.svg).toContain('fill="currentColor"');
    expect(out.svg).not.toContain(FILL);
    expect(out.svg).not.toContain('<image');
  });

  test('geometry and viewBox survive the swap', () => {
    const out = inlineMonochromeIcons(image(MONO), [FILL]);
    expect(out.svg).toContain('x="10"');
    expect(out.svg).toContain('y="20"');
    expect(out.svg).toContain('width="64"');
    expect(out.svg).toContain('height="64"');
    expect(out.svg).toContain('viewBox="0 0 24 24"');
  });

  test('ink is themed, defaulting to the light rendering when no page theme applies', () => {
    const out = inlineMonochromeIcons(image(MONO), [FILL]);
    expect(out.svg).toContain(`.d2-mono{color:${MONO_INK_LIGHT};}`);
    expect(out.svg).toContain(`html:not([data-theme="light"]) .d2-mono{color:${MONO_INK_DARK};}`);
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
    const out = inlineMonochromeIcons(mixed, [FILL]);
    expect(out.converted).toBe(1);
    expect(out.svg).toContain('<image');
    expect(out.svg).toContain('class="d2-mono"');
  });

  test('no fills configured is a no-op rather than a scan', () => {
    const before = image(MONO);
    expect(inlineMonochromeIcons(before, [])).toEqual({ svg: before, converted: 0 });
  });

  test('a monochrome payload that is not a single viewBoxed svg fails loudly', () => {
    const headless = `<g><path fill="${FILL}" d="M1 2"/></g>`;
    expect(() => inlineMonochromeIcons(image(headless), [FILL])).toThrow(SvgError);
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
    // logos ships 1861 icons and no traefik; a look-alike would be worse than
    // an honest miss.
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
