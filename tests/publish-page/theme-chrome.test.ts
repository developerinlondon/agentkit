import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markCalloutLabels } from '../../skills/publish-page/callout-labels.ts';

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

describe('cross-theme ground coherence', () => {
  // A doc and a deck rendered from the same content must sit on one ground
  // family per palette: the deck kept the cool grey when the doc moved to warm
  // paper, and nothing failed because each theme was only checked against
  // itself.
  const GROUND_FAMILY = ['--navy', '--navy-deep', '--card', '--code-bg', '--line', '--ink', '--muted'] as const;
  for (const palette of ['dark', 'light'] as const) {
    test(`${palette}: doc and deck agree on the ground family`, () => {
      const d = tokens(doc, palette);
      const k = tokens(deck, palette);
      for (const t of GROUND_FAMILY) {
        // A rename in both themes would make both sides undefined and the
        // comparison vacuously green — the doc side must actually resolve.
        expect({ token: t, doc: d[t] }).toEqual({ token: t, doc: expect.stringMatching(/^#[0-9a-f]{6}$/) });
        expect({ token: t, deck: k[t] }).toEqual({ token: t, deck: d[t] });
      }
    });
  }
});

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

// Presence of a selector answers "is this rule here", not "does it win".
// `.callout.warn strong` and `.callout > strong:first-child` tie, so order
// silently decided the label colour. This resolves the cascade instead. The
// grammar is narrow and throws on what it cannot represent, so an unrecognised
// selector fails the suite rather than being skipped.
type El = { tag: string; classes: string[]; first: boolean; last?: boolean; parent?: El; prev?: El };

function styleBlocks(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function compound(text: string) {
  const m = text.match(/^([a-z0-9]*)((?:\.[a-z0-9_-]+)*)((?::(?:first|last)-child)*)$/i);
  if (!m) throw new Error(`unsupported selector compound: ${text}`);
  const classes = m[2] ? m[2].slice(1).split('.') : [];
  const pseudo = m[3] ? m[3].split(':').filter(Boolean) : [];
  return {
    tag: m[1] ?? '',
    classes,
    first: pseudo.includes('first-child'),
    last: pseudo.includes('last-child'),
    weight: (classes.length + pseudo.length) * 1000 + (m[1] ? 1 : 0),
  };
}

const COMBINATORS: Record<string, 'child' | 'next' | 'later'> = {
  '>': 'child',
  '+': 'next',
  '~': 'later',
};

function sequence(selector: string) {
  const parts = selector.trim().split(/\s+/);
  for (const p of parts) {
    if (!COMBINATORS[p] && /[>+~]/.test(p)) {
      throw new Error(`unsupported combinator syntax: ${selector}`);
    }
  }
  const seq: Array<{ c: ReturnType<typeof compound>; comb: string }> = [];
  let comb = 'descendant';
  for (const p of parts) {
    if (COMBINATORS[p]) {
      comb = COMBINATORS[p];
      continue;
    }
    seq.push({ c: compound(p), comb });
    comb = 'descendant';
  }
  return seq;
}

function hits(c: ReturnType<typeof compound>, el: El): boolean {
  if (c.tag && c.tag !== el.tag) return false;
  if (c.first && !el.first) return false;
  if (c.last && !el.last) return false;
  return c.classes.every((k) => el.classes.includes(k));
}

function matches(selector: string, el: El): boolean {
  const seq = sequence(selector);
  let cur: El | undefined = el;
  if (!hits(seq[seq.length - 1].c, cur)) return false;
  for (let i = seq.length - 2; i >= 0; i -= 1) {
    const c = seq[i].c;
    const step = seq[i + 1].comb;
    if (step === 'child' || step === 'next') {
      cur = step === 'child' ? cur?.parent : cur?.prev;
      if (!cur || !hits(c, cur)) return false;
    } else {
      const up = (e: El | undefined) => (step === 'later' ? e?.prev : e?.parent);
      let at = up(cur);
      while (at && !hits(c, at)) at = up(at);
      if (!at) return false;
      cur = at;
    }
  }
  return true;
}

// Only a pseudo-element box or a non-base state can be dismissed without being
// understood. Anything else must parse, so a rule that cannot be proved
// irrelevant throws instead of being quietly dropped.
const NOT_BASE_STATE = /::|:(?:hover|focus|active|visited|target|focus-within|focus-visible)\b/;

function couldMatch(selector: string, el: El): boolean {
  const parts = selector.trim().split(/\s+/).filter((p) => p !== '>');
  const right = parts[parts.length - 1] ?? '';
  if (NOT_BASE_STATE.test(right)) return false;
  // A required tag or class settles a compound whatever else it carries, which
  // dismisses `svg:not(.edges)` and `.fig-lightbox[hidden]` without parsing
  // them. Anything left has to parse.
  const head = right.split(/[[:]/)[0];
  const tag = head.match(/^[a-z][a-z0-9]*/i);
  if (tag && tag[0].toLowerCase() !== el.tag) return false;
  for (const cls of head.match(/\.[a-z0-9_-]+/gi) ?? []) {
    if (!el.classes.includes(cls.slice(1))) return false;
  }
  return hits(compound(right), el);
}

// Considering only rules whose text mentioned .callout dropped candidates before
// parsing them, so a global `strong { color: red !important }` — which really
// does win in a browser — resolved as though it were not there. Every rule
// declaring the property is weighed now, priority before specificity before
// order. `reversed` re-runs with document order inverted: a winner that holds
// only one way round won on order, not on rank.
function declOf(css: string, el: El, prop: string, reversed = false): string | null {
  const rules = [...styleBlocks(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selectors: m[1].split(','), body: m[2] }));
  if (reversed) rules.reverse();
  let best: { rank: number; spec: number; order: number; value: string } | null = null;
  rules.forEach((rule, order) => {
    const safe = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The LAST declaration in a rule wins, and re-declaring a property is the
    // ordinary custom-property fallback idiom, so taking the first reported the
    // fallback rather than the value that renders.
    const decls = [...rule.body.matchAll(new RegExp(`(?:^|;)\\s*${safe}:\\s*([^;]+)`, 'g'))];
    if (decls.length === 0) return;
    const raw = decls[decls.length - 1][1].trim();
    const rank = /!\s*important$/i.test(raw) ? 1 : 0;
    const value = raw.replace(/\s*!\s*important$/i, '').trim();
    for (const part of rule.selectors) {
      const sel = part.trim();
      if (!sel || !couldMatch(sel, el) || !matches(sel, el)) continue;
      const spec = sequence(sel).reduce((n, p) => n + p.c.weight, 0);
      const better = !best || rank > best.rank
        || (rank === best.rank
          && (spec > best.spec || (spec === best.spec && order > best.order)));
      if (better) best = { rank, spec, order, value };
    }
  });
  return best === null ? null : (best as { value: string }).value;
}

// The three spellings an author actually writes. `p-strong` is what markdown
// emits when the div contains a blank line — the spelling SKILL.md mandates for
// figures — and it puts the label one level deeper than the other two.
const IDIOMS = ['strong', 'h3', 'p-strong'] as const;

function callout(severity: string | null): El {
  return { tag: 'div', classes: severity ? ['callout', severity] : ['callout'], first: true };
}

function label(severity: string | null, idiom: (typeof IDIOMS)[number]): El {
  const box = callout(severity);
  const marked = ['callout-label'];
  if (idiom === 'p-strong') {
    const para: El = { tag: 'p', classes: [], first: true, parent: box };
    return { tag: 'strong', classes: marked, first: true, parent: para };
  }
  return { tag: idiom, classes: marked, first: true, parent: box };
}

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
      // Skipping unpainted pairs silently let deck run zero assertions and
      // still report pass. The count is asserted, so a theme that stops
      // painting a pair has to say so here.
      const pairs = (name === 'doc' ? [...INK_PAIRS, ...DOC_ONLY_PAIRS] : INK_PAIRS)
        .filter(([, , bg]) => css.includes(`var(${bg})`));
      expect({ theme: name, painted: pairs.length })
        .toEqual({ theme: name, painted: name === 'doc' ? 2 : 0 });
      for (const palette of ['dark', 'light'] as const) {
        const t = tokens(css, palette);
        for (const [rule, ink, bg] of pairs) {
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
      }
      const expected: Record<string, string> = {
        plain: 'var(--note-ink)',
        note: 'var(--muted)',
        warn: 'var(--warn-ink)',
        alarm: 'var(--alarm-ink)',
        ok: 'var(--ok-ink)',
      };
      for (const [variant, ink] of Object.entries(expected)) {
        const severity = variant === 'plain' ? null : variant;
        for (const idiom of IDIOMS) {
          expect({ variant, idiom, color: declOf(css, label(severity, idiom), 'color') })
            .toEqual({ variant, idiom, color: ink });
        }
      }
    });

    test(`${name} label colour is won by specificity, not by rule order`, () => {
      for (const variant of [null, ...SEVERITIES]) {
        for (const idiom of IDIOMS) {
          const el = label(variant, idiom);
          expect({ variant, idiom, color: declOf(css, el, 'color', true) })
            .toEqual({ variant, idiom, color: declOf(css, el, 'color') });
        }
      }
    });

    test(`${name} does not make the same callout two heights`, () => {
      // Only some spellings put the body in a <p>. A UA margin there is dead
      // space inside the callout's own padding, which padding cannot collapse,
      // so two callouts written the two documented ways stack differently.
      const box = callout(null);
      const body: El = { tag: 'p', classes: [], first: true, parent: box };
      const last: El = { tag: 'p', classes: [], first: false, last: true, parent: box, prev: body };
      expect({ theme: name, margin: declOf(css, body, 'margin') })
        .toEqual({ theme: name, margin: '0 0 0.5rem' });
      expect({ theme: name, trailing: declOf(css, last, 'margin-bottom') })
        .toEqual({ theme: name, trailing: '0' });
    });

    test(`${name} leaves emphasis inside callout body text in ink`, () => {
      // Only the leading label carries severity; a bold phrase mid-sentence is
      // body text and must take no colour rule at all.
      const parent: El = { tag: 'div', classes: ['callout', 'warn'], first: true };
      const inline: El = { tag: 'strong', classes: [], first: false, parent };
      const para: El = { tag: 'p', classes: [], first: false, parent };
      const trailing: El = { tag: 'strong', classes: [], first: true, parent: para };
      for (const [what, el] of [['mid-sentence', inline], ['opening a later paragraph', trailing]] as const) {
        expect({ theme: name, what, color: declOf(css, el, 'color') })
          .toEqual({ theme: name, what, color: null });
      }
    });

    test(`${name} callouts sit on --card so they lift off the page`, () => {
      // A severity-tinted ground presses the callout INTO the paper; the rail
      // carries the colour and the card carries the lift. Resolved rather than
      // text-matched, so a reintroduced ground fails however it is spelled.
      const ground = name === 'doc' ? 'var(--code-bg)' : 'var(--card)';
      for (const s of [null, ...SEVERITIES]) {
        const box = callout(s);
        expect({ theme: name, severity: s, bg: declOf(css, box, 'background') })
          .toEqual({ theme: name, severity: s, bg: s === 'note' ? ground : 'var(--card)' });
        // Naming one spelling at a time left the adjacent one open twice over.
        // Painting a ground is a property family, so the whole family is asked
        // for: a single-colour gradient is a flat ground to a reader.
        for (const longhand of ['background-color', 'background-image']) {
          expect({ theme: name, severity: s, longhand, value: declOf(css, box, longhand) })
            .toEqual({ theme: name, severity: s, longhand, value: null });
        }
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
  // Brace-depth scan, not a delimiter guess. Terminating on `\n  }` only ever
  // matched multi-line rules, so a single-line rule's slice ran on into its
  // neighbours and picked up their declarations — h2 read as capped because h3
  // was. A missing selector throws rather than returning a value the assertion
  // is happy with either way.
  function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(`\n  ${selector} {`);
    if (at === -1) throw new Error(`selector not found in theme: ${selector}`);
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) return css.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${selector}`);
  }

  test('anything read as prose is capped at the measure, not the column', () => {
    expect(doc).toContain('--measure: 43rem;');
    for (const sel of ['h2', 'h3', '.callout', 'pre', '.kicker']) {
      const body = ruleBody(doc, sel);
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

describe('callout titles are headings', () => {
  for (const theme of [['doc', doc], ['deck', deck]] as const) {
    const [name, css] = theme;
    test(`${name} sets a callout title as a block heading in every idiom`, () => {
      // A titled aside, not a paragraph with a bold lead-in: the label breaks to
      // its own line and sizes above the body it introduces. Asserting this on
      // the rule text passed while the markdown idiom rendered inline, because
      // the rule it read was not the rule that idiom lands on.
      for (const idiom of IDIOMS) {
        for (const variant of [null, ...SEVERITIES]) {
          const el = label(variant, idiom);
          expect({ idiom, variant, display: declOf(css, el, 'display') })
            .toEqual({ idiom, variant, display: 'block' });
          expect({ idiom, variant, size: declOf(css, el, 'font-size') })
            .toEqual({ idiom, variant, size: '1.02rem' });
        }
      }
    });
  }
});

const markedCallouts = (html: string) => markCalloutLabels(html);
const markedCalloutCount = (html: string) =>
  (markCalloutLabels(html).match(/callout-label/g) ?? []).length;

describe('callout labels are marked by document order, not element position', () => {
  for (
    const [spelling, html] of [
      ['a direct strong', '<div class="callout warn"><strong>Heads up.</strong> body</div>'],
      ['a markdown blank-line body', '<div class="callout warn"><p><strong>Heads up.</strong> body</p></div>'],
      ['an author-wrapped p', '<div class="callout"><p><strong>Heads up.</strong> body</p></div>'],
      ['a heading', '<div class="callout note"><h3>Heads up</h3><p>body</p></div>'],
      ['a heading with attributes', '<div class="callout"><h3 id="x">Heads up</h3><p>body</p></div>'],
      ['the class after another attribute', '<div id="x" class="callout warn"><strong>Heads up.</strong></div>'],
      ['callout after another class token', '<div class="warn callout"><strong>Heads up.</strong></div>'],
      ['a single-quoted class', "<div class='callout warn'><strong>Heads up.</strong></div>"],
    ] as const
  ) {
    test(`${spelling} is a label`, () => {
      expect(markedCalloutCount(html)).toBe(1);
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
      const out = markedCallouts(html);
      const promoted = spelling === 'bold mid-sentence' ? 1 : 0;
      expect((out.match(/callout-label/g) ?? []).length).toBe(promoted);
    });
  }

  // `\b` sits between the hyphen and the c, so a bare \bclass matches
  // data-class too. The marker landed inside the data attribute, which reads as
  // marked while the element carries no real class and renders unstyled.
  test('a data-class attribute is not mistaken for class', () => {
    const out = markedCallouts('<div class="callout"><h3 data-class="k">L</h3></div>');
    expect(out).toContain('data-class="k"');
    expect(out).toContain('class="callout-label"');
  });

  test('a div carrying only data-class="callout" is not a callout', () => {
    expect(markedCalloutCount('<div data-class="callout"><strong>x</strong></div>')).toBe(0);
  });

  test('two spaces after the tag name still parse', () => {
    expect(markedCalloutCount('<div  class="callout"><strong>L.</strong></div>')).toBe(1);
  });

  test('a class that merely starts with callout is not a callout', () => {
    expect(markedCalloutCount('<div class="callout-ish"><strong>x</strong></div>')).toBe(0);
  });

  test('marking twice does not stack the class', () => {
    const once = markedCallouts('<div class="callout"><strong>L.</strong></div>');
    expect(markCalloutLabels(once)).toBe(once);
  });

  test('a label that already carries a class keeps it', () => {
    const html = '<div class="callout"><h3 class="tight">Label</h3></div>';
    expect(markedCallouts(html)).toContain('class="callout-label tight"');
    expect(markedCalloutCount(html)).toBe(1);
  });

  test('bold outside a callout is untouched', () => {
    const html = '<p>Ordinary <strong>prose</strong>.</p><div class="cards"><strong>x</strong></div>';
    expect(markedCallouts(html)).toBe(html);
  });

  test('every severity spelling is marked', () => {
    for (const s of ['', ' warn', ' alarm', ' ok', ' note']) {
      expect(markedCalloutCount(`<div class="callout${s}"><strong>L.</strong> b</div>`)).toBe(1);
    }
  });
});
