import { describe, expect, test } from 'bun:test';
import { markCalloutLabels } from '../../skills/publish-page/callout-labels.ts';

const marked = (html: string) => markCalloutLabels(html);
const labels = (html: string) => (markCalloutLabels(html).match(/callout-label/g) ?? []).length;

describe('callout labels are marked by document order, not element position', () => {
  for (
    const [spelling, html] of [
      ['a direct strong', '<div class="callout warn"><strong>Heads up.</strong> body</div>'],
      ['a markdown blank-line body', '<div class="callout warn"><p><strong>Heads up.</strong> body</p></div>'],
      ['an author-wrapped p', '<div class="callout"><p><strong>Heads up.</strong> body</p></div>'],
      ['a heading', '<div class="callout note"><h3>Heads up</h3><p>body</p></div>'],
      ['a heading with attributes', '<div class="callout"><h3 id="x">Heads up</h3><p>body</p></div>'],
    ] as const
  ) {
    test(`${spelling} is a label`, () => {
      expect(labels(html)).toBe(1);
    });
  }

  for (
    const [spelling, html] of [
      [
        'bold after leading text in a p',
        '<div class="callout ok"><p>Plain opening, then a <strong>bold phrase</strong> later.</p></div>',
      ],
      [
        'bold after leading text in the div',
        '<div class="callout warn">Leading prose, then a <strong>bold phrase</strong> here.</div>',
      ],
      [
        'bold mid-sentence',
        '<div class="callout"><strong>Real label.</strong> body with <strong>emphasis</strong>.</div>',
      ],
      [
        'a heading deep in the body',
        '<div class="callout"><p>body</p><h3>Not a label</h3></div>',
      ],
    ] as const
  ) {
    test(`${spelling} is not promoted`, () => {
      // `:first-child` counts elements, so every one of these reads as "first"
      // to CSS. Styling them as headings snaps the sentence onto two lines.
      const out = marked(html);
      const promoted = spelling === 'bold mid-sentence' ? 1 : 0;
      expect((out.match(/callout-label/g) ?? []).length).toBe(promoted);
    });
  }

  test('a label that already carries a class keeps it', () => {
    const out = marked('<div class="callout"><h3 class="tight">Label</h3></div>');
    expect(out).toContain('class="callout-label tight"');
    expect(labels('<div class="callout"><h3 class="tight">Label</h3></div>')).toBe(1);
  });

  test('bold outside a callout is untouched', () => {
    const html = '<p>Ordinary <strong>prose</strong>.</p><div class="cards"><strong>x</strong></div>';
    expect(marked(html)).toBe(html);
  });

  test('every severity spelling is marked', () => {
    for (const s of ['', ' warn', ' alarm', ' ok', ' note']) {
      expect(labels(`<div class="callout${s}"><strong>L.</strong> b</div>`)).toBe(1);
    }
  });
});
