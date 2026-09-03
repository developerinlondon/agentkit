import { describe, expect, test } from 'bun:test';
import { backgroundRect, resolveBackground, SvgError } from '../../skills/diagram/scripts/excalidraw-svg.ts';

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
