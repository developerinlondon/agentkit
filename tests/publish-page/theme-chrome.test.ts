import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const themes = join(import.meta.dir, '..', '..', 'skills', 'publish-page', 'themes');
const doc = readFileSync(join(themes, 'doc.html'), 'utf8');
const deck = readFileSync(join(themes, 'deck.html'), 'utf8');

const SEVERITIES = ['note', 'warn', 'alarm', 'ok'] as const;

// The token pair each rule ACTUALLY sets, read off the CSS. `.callout.note`
// deliberately reuses the shared --muted/--code-bg, so asserting --note-* there
// guards a pairing the page never renders.
const INK_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['.callout', '--note-ink', '--note-bg'],
  ['.callout.warn', '--warn-ink', '--warn-bg'],
  ['.callout.alarm', '--alarm-ink', '--alarm-bg'],
  ['.callout.ok', '--ok-ink', '--ok-bg'],
  ['.callout.note', '--muted', '--code-bg'],
];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Tokens are declared twice — the dark :root and the light override — so each
// palette is read from the block that actually defines it.
function tokens(css: string, palette: 'dark' | 'light'): Record<string, string> {
  const start = palette === 'dark' ? css.indexOf('  :root {') : css.indexOf('html[data-theme="light"] {');
  const block = css.slice(start, css.indexOf('\n  }', start));
  const found: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/g)) found[m[1]] = m[2];
  return found;
}

describe('labelled section nav', () => {
  test('the doc theme ships a section nav, not an unlabelled dot rail', () => {
    // A rail of anonymous dots cannot tell a reader what the page covers.
    expect(doc).toContain('<nav class="secnav" id="secNav"');
    expect(doc).not.toContain('toc-rail');
    expect(doc).not.toContain('tocRail');
  });

  test('tabs carry their heading text and the full title on hover', () => {
    expect(doc).toContain('a.textContent = navLabel(h)');
    expect(doc).toContain('a.title = h.textContent.trim()');
  });

  test('an author can override a long title with data-nav', () => {
    expect(doc).toContain('if (h.dataset.nav) return h.dataset.nav.trim();');
  });

  test('a derived label is always marked as an abbreviation', () => {
    // "One service, one database, no agent, no operator" shortens to "One
    // service", which reads as a complete thought and is not one. The ellipsis
    // is what separates a name the author chose from one the page invented.
    expect(doc).toContain('+ "…";');
  });

  test('the sticky bar leaves room for anchors and hides itself in print', () => {
    expect(doc).toContain('main h2 { scroll-margin-top:');
    expect(doc).toMatch(/@media print \{ \.theme-toggle, \.secnav \{ display: none; \} \}/);
  });
});

describe('callout severities', () => {
  for (const theme of [['doc', doc], ['deck', deck]] as const) {
    const [name, css] = theme;
    test(`${name} defines every severity in both palettes`, () => {
      for (const palette of ['dark', 'light'] as const) {
        const t = tokens(css, palette);
        for (const s of SEVERITIES) {
          expect(t[`--${s}-ink`]).toBeDefined();
          expect(t[`--${s}-bg`]).toBeDefined();
        }
      }
    });

    test(`${name} label ink clears 4.5:1 on the ground the rule actually sets`, () => {
      // The label sits ON the severity ground, so the shared --gold/--red are
      // not safe there; this is the guard that caught them at 4.33 and 4.07.
      for (const palette of ['dark', 'light'] as const) {
        const t = tokens(css, palette);
        for (const [rule, ink, bg] of INK_PAIRS) {
          const r = ratio(t[ink], t[bg]);
          expect({ palette, rule, pass: r >= 4.5 }).toEqual({ palette, rule, pass: true });
        }
      }
    });

    test(`${name} body ink stays readable on every severity ground`, () => {
      for (const palette of ['dark', 'light'] as const) {
        const t = tokens(css, palette);
        for (const [, , bg] of INK_PAIRS) {
          expect(ratio(t['--ink'], t[bg])).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    test(`${name} carries severity on the rail and label, never on body text`, () => {
      for (const s of SEVERITIES.filter((x) => x !== 'note')) {
        expect(css).toContain(`.callout.${s} { border-left-color: var(--${s}-ink); background: var(--${s}-bg); }`);
        expect(css).toContain(`.callout.${s} strong { color: var(--${s}-ink); }`);
      }
    });
  }
});

describe('d2 figures are exempt from the light-mode inversion', () => {
  for (const theme of [['doc', doc], ['deck', deck]] as const) {
    const [name, css] = theme;
    test(`${name} does not double-flip a D2 diagram`, () => {
      // D2 emits both palettes itself; inverting on top of that renders the
      // dark palette in light mode and recolours every embedded vendor logo.
      expect(css).toContain('html[data-theme="light"] svg[role="img"]:not(.edges):not(.d2) {');
    });
  }
});
