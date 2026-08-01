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
// Only pairs something actually paints. Guarding a token no pixel can take
// makes the suite loud about the invisible and silent about the visible: three
// severity grounds went unrendered while .chip.hot, the pair this theme newly
// introduced, had no ratio assertion at all.
const INK_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['.chip.hot', '--accent', '--note-bg'],
];

const DOC_ONLY_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
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
    test(`${name} defines an ink for every severity in both palettes`, () => {
      // Ink is what every severity paints — on the rail and the label. A ground
      // is only defined where something actually fills with it.
      for (const palette of ['dark', 'light'] as const) {
        const t = tokens(css, palette);
        for (const s of SEVERITIES) expect(t[`--${s}-ink`]).toBeDefined();
      }
    });

    test(`${name} every painted ink/ground pair clears 4.5:1`, () => {
      const pairs = name === 'doc' ? [...INK_PAIRS, ...DOC_ONLY_PAIRS] : INK_PAIRS;
      for (const palette of ['dark', 'light'] as const) {
        const t = tokens(css, palette);
        for (const [rule, ink, bg] of pairs) {
          if (!css.includes(`var(${bg})`)) continue;
          const r = ratio(t[ink], t[bg]);
          expect({ palette, rule, pass: r >= 4.5 }).toEqual({ palette, rule, pass: true });
        }
      }
    });

    test(`${name} defines no severity ground it never paints`, () => {
      // A token nothing renders cannot be verified by looking at the page, so
      // it must not be carried as if it were covered.
      for (const s of SEVERITIES) {
        const declared = css.includes(`--${s}-bg:`);
        const painted = css.includes(`var(--${s}-bg)`);
        expect({ token: `--${s}-bg`, deadWeight: declared && !painted })
          .toEqual({ token: `--${s}-bg`, deadWeight: false });
      }
    });

    test(`${name} carries severity on the rail and label, never on body text`, () => {
      for (const s of SEVERITIES.filter((x) => x !== 'note')) {
        expect(css).toContain(`.callout.${s} { border-left-color: var(--${s}-ink); }`);
        expect(css).toContain(`.callout.${s} strong { color: var(--${s}-ink); }`);
      }
    });

    test(`${name} callouts sit on --card so they lift off the page`, () => {
      // A severity-tinted ground presses the callout INTO the paper; the rail
      // carries the colour and the card carries the lift.
      expect(css).toMatch(/\.callout \{[\s\S]*?background: var\(--card\);/);
      for (const s of SEVERITIES.filter((x) => x !== 'note')) {
        expect(css).not.toContain(`.callout.${s} { border-left-color: var(--${s}-ink); background:`);
      }
    });

    test(`${name} label ink clears 4.5:1 on --card, the ground callouts render on`, () => {
      // The guard above checks the tokens as an offered pair; this checks the
      // pair the theme itself puts on screen. Both are real, and only this one
      // changes when the callout ground changes.
      for (const palette of ['dark', 'light'] as const) {
        const t = tokens(css, palette);
        for (const ink of ['--note-ink', '--warn-ink', '--alarm-ink', '--ok-ink', '--muted']) {
          expect({ palette, ink, pass: ratio(t[ink], t['--card']) >= 4.5 })
            .toEqual({ palette, ink, pass: true });
        }
        expect(ratio(t['--ink'], t['--card'])).toBeGreaterThanOrEqual(4.5);
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

describe('editorial typography', () => {
  test('the headline scales fluidly instead of sitting at one timid size', () => {
    expect(doc).toMatch(/h1 \{[\s\S]*?font-size: clamp\(2rem, 4\.4vw, 2\.9rem\)/);
  });

  test('the opening paragraph is set apart as a lede', () => {
    // Selected structurally, because a markdown author writes a paragraph after
    // the title, not a class.
    expect(doc).toContain('main > h1 + p, main > .chips + p');
    expect(doc).toContain('font-family: var(--f-serif)');
    expect(doc).toContain('border-bottom: 1px solid var(--line)');
  });

  test('one chip can lead the row', () => {
    expect(doc).toContain('.chip.hot { border-color: var(--accent);');
  });

  test('light mode is warm paper, not an inverted dark theme', () => {
    const light = tokens(doc, 'light');
    expect(light['--navy']).toBe('#faf9f5');
    expect(light['--ink']).toBe('#141413');
    // Every pair the theme renders must still clear its floor on the new ground.
    for (const [rule, ink, bg] of INK_PAIRS) {
      expect({ rule, pass: ratio(light[ink], light[bg]) >= 4.5 }).toEqual({ rule, pass: true });
    }
    expect(ratio(light['--ink'], light['--navy'])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(light['--muted'], light['--navy'])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('width tiers', () => {
  // Reads the rule body rather than building a regex: an over-escaped pattern
  // silently matches nothing and the guard passes on a theme that has no caps.
  function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(`\n  ${selector} {`);
    if (at === -1) return '';
    return css.slice(at, css.indexOf('\n  }', at) + 4);
  }

  test('anything read as prose is capped at the measure, not the column', () => {
    expect(doc).toContain('--measure: 43rem;');
    for (const sel of ['h2', 'h3', '.callout', 'pre', '.kicker']) {
      const body = ruleBody(doc, sel);
      expect({ sel, found: body.length > 0 }).toEqual({ sel, found: true });
      expect({ sel, capped: body.includes('max-width: var(--measure)') })
        .toEqual({ sel, capped: true });
    }
  });

  test('only h1, tables and figures take the full column', () => {
    expect(doc).toContain('main { max-width: 64rem;');
    for (const sel of ['h1', '.figure']) {
      expect({ sel, capped: ruleBody(doc, sel).includes('var(--measure)') })
        .toEqual({ sel, capped: false });
    }
  });
});
