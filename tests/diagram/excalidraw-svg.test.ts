import { describe, expect, test } from 'bun:test';
import {
  applyHouseAttributes,
  backgroundRect,
  resolveBackground,
  SvgError,
} from '../../skills/diagram/scripts/excalidraw-svg.ts';

const SVG = '<svg version="1.1" viewBox="0 -10 100 200" width="100" height="200"><g/></svg>';

describe('excalidraw background rect', () => {
  test('emits a rect sized to the viewBox, painted behind the scene', () => {
    const out = backgroundRect(SVG, '#fbfbfa');
    expect(out).toContain('<svg version="1.1" viewBox="0 -10 100 200" width="100" height="200">'
      + '<rect x="0" y="-10" width="100" height="200" fill="#fbfbfa"/>');
    expect(out.indexOf('<rect')).toBeLessThan(out.indexOf('<g/>'));
  });

  test('escapes the fill value rather than injecting it raw', () => {
    const out = backgroundRect(SVG, '"><script>x</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('fill="&quot;>&lt;script>x&lt;/script>"');
  });

  test('refuses a root with no viewBox', () => {
    expect(() => backgroundRect('<svg width="10" height="10"><g/></svg>', '#fff'))
      .toThrow(SvgError);
  });

  test('refuses input that does not start with an <svg> tag', () => {
    expect(() => backgroundRect('<g/>', '#fff')).toThrow(SvgError);
  });
});

describe('excalidraw background resolution', () => {
  test('an explicit --background wins over the scene', () => {
    expect(resolveBackground('#111111', '#fbfbfa')).toBe('#111111');
  });

  test('falls back to the scene viewBackgroundColor when nothing is explicit', () => {
    expect(resolveBackground(undefined, '#fbfbfa')).toBe('#fbfbfa');
  });

  test('"transparent" means no rect, matching Excalidraw\'s own convention', () => {
    expect(resolveBackground(undefined, 'transparent')).toBeUndefined();
    expect(resolveBackground(undefined, 'Transparent')).toBeUndefined();
  });

  test('a scene with no colour and nothing explicit stays background-free', () => {
    expect(resolveBackground(undefined, undefined)).toBeUndefined();
    expect(resolveBackground(undefined, 42)).toBeUndefined();
  });
});

describe('house attributes', () => {
  test('the sketch root ships the same contract as the d2 and draw.io registers', () => {
    const out = applyHouseAttributes(SVG, 'a pipeline');
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="a pipeline"');
    expect(out).toContain('width="100" height="200" style="max-width:100%;height:auto"');
    expect(out).toContain('viewBox="0 -10 100 200"');
    // width="100%" is what upscaled every figure narrower than the column.
    expect(out).not.toContain('100%"');
  });

  test('a fractional excalidraw size is rounded up, not truncated', () => {
    const out = applyHouseAttributes('<svg version="1.1" viewBox="0 0 556 1116.5"><g/></svg>', 'x');
    expect(out).toContain('width="556" height="1117"');
  });

  test("a root style the renderer already set is kept, with the cap merged after it", () => {
    // Two style attributes on one tag is not a merge — the browser reads the
    // first, and the cap would be dead markup.
    const out = applyHouseAttributes('<svg style="color:red" viewBox="0 0 10 20"></svg>', 'x');
    expect(out).toContain('style="color:red;max-width:100%;height:auto"');
    expect([...out.matchAll(/\bstyle="/g)]).toHaveLength(1);
  });

  test('a label carrying markup cannot break out of the attribute', () => {
    const out = applyHouseAttributes(SVG, 'a "quoted" <tag> & more');
    expect(out).toContain('aria-label="a &quot;quoted&quot; &lt;tag> &amp; more"');
  });

  test('a root with no viewBox is refused rather than shipped unsized', () => {
    expect(() => applyHouseAttributes('<svg width="10" height="20"></svg>', 'x')).toThrow(SvgError);
  });

  test('input that is not an svg is refused', () => {
    expect(() => applyHouseAttributes('<html></html>', 'x')).toThrow(SvgError);
  });
});
