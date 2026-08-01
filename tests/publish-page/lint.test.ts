import { describe, expect, test } from 'bun:test';
import { lintFigures } from '../../skills/publish-page/lint.ts';

const SVG = '<svg version="1.1" width="100%" role="img" aria-label="x"><!-- svg-source:excalidraw --><metadata></metadata></svg>';

describe('publish-page figure lint', () => {
  test('a .figure-wrapped diagram passes, including a <p> between wrapper and svg', () => {
    const html = `<div class="figure">\n<p>${SVG}</p>\n<div class="figcaption">c</div></div>`;
    expect(lintFigures(html)).toEqual({ errors: [], warnings: [] });
  });

  test('the shipped white-island shape is refused with the fix named', () => {
    // The exact defect that reached production: custom container, hardcoded
    // white background, navy-palette SVG — illegible in both themes.
    const html = `<style>.study .diagram { border-radius: 14px; background: white; overflow: hidden; }</style>
<div class="study"><div class="diagram">${SVG}</div></div>`;
    const result = lintFigures(html);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('.figure');
    expect(result.errors[0]).toContain('var(--diagram-bg)');
    expect(result.warnings).toHaveLength(1);
  });

  test('the repaired shape passes: custom container styled with var(--diagram-bg)', () => {
    const html = `<style>.study .diagram { background: var(--diagram-bg, #0e0f12); overflow: hidden; }</style>
<div class="study"><div class="diagram">${SVG}</div></div>`;
    expect(lintFigures(html).errors).toEqual([]);
  });

  test('a bare svg with no container at all is refused', () => {
    expect(lintFigures(`<main>${SVG}</main>`).errors).toHaveLength(1);
  });

  test('--allow-bare-svg suppresses the error but keeps the contrast warning', () => {
    const html = `<style>.d { background: #fff }</style><div class="d">${SVG}</div>`;
    const result = lintFigures(html, true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  test('pages without a baked diagram are never flagged', () => {
    const html = '<style>.hero { background: white }</style><div class="hero"><svg viewBox="0 0 24 24"></svg></div>';
    expect(lintFigures(html)).toEqual({ errors: [], warnings: [] });
  });

  test('a legitimately tinted background like #fff9ec does not trip the warning', () => {
    const html = `<style>.status { background: #fff9ec }</style><div class="figure">${SVG}</div>`;
    expect(lintFigures(html).warnings).toEqual([]);
  });

  test('a distant .figure from an earlier, closed island does not cover a bare svg', () => {
    const filler = '<p>x</p>'.repeat(160);
    const html = `<div class="figure">old</div>${filler}${SVG}`;
    expect(lintFigures(html).errors).toHaveLength(1);
  });

  test('a CLOSED .figure immediately before a bare svg does not cover it', () => {
    const html = `<div class="figure">old</div><p>hi</p>${SVG}`;
    expect(lintFigures(html).errors).toHaveLength(1);
  });

  test('a closed .figure followed by a sibling wrapper div does not cover it either', () => {
    // Totals-based depth counting read close+open as still-open; the walk
    // must be ordered.
    const html = `<div class="figure">old</div><div class="wrap">${SVG}</div>`;
    expect(lintFigures(html).errors).toHaveLength(1);
  });

  test('an unstyled inner div inside an open .figure still counts as wrapped', () => {
    const html = `<div class="figure"><div class="inner">${SVG}</div></div>`;
    expect(lintFigures(html).errors).toEqual([]);
  });

  test('a prefix-named class does not borrow another rule: .diagrams cannot cover .diagram', () => {
    const html = `<style>.diagrams { background: var(--diagram-bg) } .diagram { background: white }</style>
<div class="diagram">${SVG}</div>`;
    expect(lintFigures(html).errors).toHaveLength(1);
  });

  test('var(--diagram-bg) on a non-background property does not qualify', () => {
    const html = `<style>.d { border-color: var(--diagram-bg); background: white }</style><div class="d">${SVG}</div>`;
    expect(lintFigures(html).errors).toHaveLength(1);
  });

  test('background-color spelling and single-quoted class attributes are understood', () => {
    const html = `<style>.hero { background-color: white }</style><div class='figure'>${SVG}</div>`;
    const result = lintFigures(html);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('diagram stylesheet leakage', () => {
  // Real d2 output salts every selector, verified against a rendered figure:
  // `.d2-1846797904 .background-color-N7{background-color:#FFFFFF;}`.
  const d2Style = '<style>.d2-123 .fill-N1{fill:#0A0F25;}'
    + '.d2-123 .background-color-N7{background-color:#FFFFFF;}</style>';

  test("d2's own stylesheet does not trip the white-ground warning", () => {
    // It always ships background-color:#FFFFFF, so scanning it as page CSS
    // fires on every correct figure and trains the author to ignore the check.
    const html = `<div class="figure"><!-- svg-source:d2 --><svg class="d2">${d2Style}</svg></div>`;
    expect(lintFigures(html).warnings).toEqual([]);
  });

  test('a page that really hardcodes a white ground is still warned about', () => {
    const html = `<style>.mine{background:#ffffff}</style>`
      + `<div class="figure"><!-- svg-source:d2 --><svg class="d2">${d2Style}</svg></div>`;
    expect(lintFigures(html).warnings.join(' ')).toContain('white background');
  });

  test('a stylesheet escaped into page text is reported, not silently passed', () => {
    // The figure island and caption stay intact; only the diagram is gone, so
    // every structural check passes while the page shows a wall of CSS.
    const html = '<div class="figure"><!-- svg-source:d2 -->'
      + '<pre><code>&lt;style&gt;.d2-mono{color:#3f3f46;}&lt;/style&gt;</code></pre></div>';
    expect(lintFigures(html).warnings.join(' ')).toContain('appears as page text');
  });

  test('documenting d2 CSS never blocks a publish', () => {
    // A fence and a leak are the same input class, and publish.ts hard-fails on
    // errors — so this must not be one. The repo's own reference documents
    // `.d2-mono` by name and has to remain publishable beside a figure.
    const html = `<div class="figure"><!-- svg-source:d2 --><svg class="d2">${d2Style}</svg></div>`
      + '<pre><code class="language-css">.d2-mono { color: #3f3f46; }</code></pre>';
    expect(lintFigures(html).errors).toEqual([]);
  });

  test("an author's own white ground is still caught beside a .d2-mono override", () => {
    // Dropping the whole <style> element would disable the check for the page:
    // the house theme ships one stylesheet, and the skill now tells authors
    // .d2-mono is theirs to restyle.
    const html = '<style>.figure{background:#ffffff}\n.d2-mono{color:red}</style>'
      + `<div class="figure"><!-- svg-source:d2 --><svg class="d2">${d2Style}</svg></div>`;
    expect(lintFigures(html).warnings.join(' ')).toContain('white background');
  });
});

describe('d2 rule stripping is rule-accurate', () => {
  const fig = '<div class="figure"><!-- svg-source:d2 --><svg class="d2"></svg></div>';
  const warns = (css: string) => lintFigures(`<style>${css}</style>${fig}`).warnings.length;

  test("a grouped selector keeps the author's half of the rule", () => {
    // `.figure,.d2-mono{...}` is an author rule too; dropping it whole hid a
    // white ground the check exists to report.
    expect(warns('.figure,.d2-mono{background:#ffffff}')).toBe(1);
  });

  test('a comment naming .d2- does not swallow the rule beneath it', () => {
    expect(warns('/* d2 marks use .d2-mono */\n.figure{background:#ffffff}')).toBe(1);
  });

  test("d2's own rules alone still produce no warning", () => {
    expect(warns('.d2-1846797904 .background-color-N7{background-color:#FFFFFF;}')).toBe(0);
  });

  test('a class that merely starts like a d2 class is not stripped', () => {
    expect(warns('.d2wrapper{background:#ffffff}')).toBe(1);
  });
});
