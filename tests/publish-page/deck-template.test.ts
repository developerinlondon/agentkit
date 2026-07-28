import { describe, expect, test } from 'bun:test';
import { bundledThemePath, renderThemed } from '../../skills/publish-page/render-html.ts';

// renderThemed's deck branch is the shared splitter's other consumer. Without
// a test here, breaking the fence tracking reddened only the product suite —
// the module the publisher depends on answered to somebody else's tests, and
// the brief renderer neutralises its output against exactly this behaviour.
const sections = (html: string) => (html.match(/<section class="slide">/g) ?? []).length;

const deck = (source: string) =>
  renderThemed({
    source,
    isMd: true,
    template: 'deck',
    title: 'deck',
    themePath: bundledThemePath('deck'),
  });

describe('deck template sectioning', () => {
  test('a lone rule cuts a slide', async () => {
    expect(sections(await deck(['one', '', '---', '', 'two'].join('\n')))).toBe(2);
  });

  test('a rule inside a fence is code, not a cut', async () => {
    const html = await deck(['one', '', '```sh', 'git log', '---', '```', '', '---', '', 'two'].join('\n'));
    expect(sections(html)).toBe(2);
  });

  // trim() spans the whole Unicode whitespace set, so these cut too — which is
  // why a renderer emitting into this grammar cannot guard with a narrower one.
  test.each([
    ['NBSP', '\u00a0'],
    ['form feed', '\u000c'],
    ['BOM', '\ufeff'],
  ])('a rule prefixed with a %s still cuts', async (_name, space) => {
    expect(sections(await deck(['one', '', `${space}---`, '', 'two'].join('\n')))).toBe(2);
  });

  test('frontmatter opens no slide of its own', async () => {
    expect(sections(await deck(['---', 'title: t', '---', '', 'only'].join('\n')))).toBe(1);
  });
});
