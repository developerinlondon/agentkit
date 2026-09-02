import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect, SvgError, verifySelfContained } from '../../skills/diagram/scripts/d2-svg.ts';
import {
  applyHouseAttributes,
  isCompressed,
  namespaceIds,
  PLATE,
  plateBackground,
  saltFor,
  screenSource,
  SOURCE_MARK,
  stripPrologue,
  verifyReferences,
} from '../../skills/diagram/scripts/drawio-svg.ts';

const example = join(import.meta.dir, '../../skills/diagram/examples/cloud-topology.svg');
const source = join(import.meta.dir, '../../skills/diagram/examples/cloud-topology.drawio');

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" '
  + '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n';
const ROOT = '<svg xmlns="http://www.w3.org/2000/svg" style="background: transparent; '
  + 'color-scheme: light dark;" width="100px" height="50px" viewBox="0 0 100 50">';

describe('the DOCTYPE draw.io writes is stripped', () => {
  test('the external DTD would otherwise fail the containment check', () => {
    const raw = `${HEAD}${ROOT}<text>x</text></svg>`;
    expect(inspect(raw).externalUrls).toContain(
      'http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd',
    );
    expect(inspect(stripPrologue(raw)).externalUrls).toEqual([]);
  });

  test('a payload that does not start with <svg> is refused, not silently shipped', () => {
    expect(() => stripPrologue('<html><body>nope</body></html>')).toThrow(SvgError);
  });
});

describe('the figure carries its own plate', () => {
  // draw.io's dark theme remaps every authored colour, brand fills included, so
  // the figure is exported light-only — which needs a surface of its own or it
  // is unreadable on the island's dark ground.
  test('a full-bleed rect matching the viewBox is inserted first', () => {
    const out = plateBackground(`${ROOT}<text>x</text></svg>`);
    expect(out).toContain(`<rect x="0" y="0" width="100" height="50" fill="${PLATE}"/>`);
    expect(out.indexOf('<rect')).toBeLessThan(out.indexOf('<text'));
  });

  test('the root color-scheme is dropped so no viewer reinterprets the palette', () => {
    expect(plateBackground(`${ROOT}</svg>`)).not.toContain('color-scheme');
  });

  test('a render with no viewBox is refused rather than plated at the wrong size', () => {
    expect(() => plateBackground('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
      .toThrow(SvgError);
  });
});

describe('ids are namespaced per figure', () => {
  const RAW = '<svg viewBox="0 0 10 10"><defs><linearGradient '
    + 'id="drawio-svg-J-gA13gOpOlOpL6JsM29-gradient-a"/></defs>'
    + '<g id="0"><rect id="alb" fill="url(#drawio-svg-J-gA13gOpOlOpL6JsM29-gradient-a)"/></g></svg>';

  test("draw.io's per-render salt is replaced, so the same source renders the same bytes", () => {
    const once = namespaceIds(RAW, 'fig');
    const twice = namespaceIds(RAW.replaceAll('J-gA13gOpOlOpL6JsM29', 'xFBTcgfvkFDSNSb7E4t-'), 'fig');
    expect(once).toBe(twice);
    expect(once).not.toContain('drawio-svg-');
  });

  test('bare mxCell ids are namespaced, because id="0" collides with the page', () => {
    expect(namespaceIds(RAW, 'fig')).toContain('id="fig-0"');
    expect(namespaceIds(RAW, 'fig')).toContain('id="fig-alb"');
  });

  test('every reference is rewritten with its id, leaving nothing dangling', () => {
    const out = namespaceIds(RAW, 'fig');
    const refs = [...out.matchAll(/url\(#([^)]*)\)/g)].map((m) => m[1]);
    expect(refs).toEqual(['fig-gradient-a']);
    expect(refs.filter((r) => !out.includes(`id="${r}"`))).toEqual([]);
  });

  test('the escaped spelling inside style= is rewritten, not just the attribute', () => {
    // draw.io writes the paint server twice and CSS honours the style copy, so
    // rewriting only fill="url(#x)" leaves the shape unpainted and nothing else
    // out of place — which is exactly how it shipped once.
    const raw = '<svg viewBox="0 0 10 10"><linearGradient id="drawio-svg-J-gA13gOpOlOpL6JsM29-g"/>'
      + '<path fill="url(#drawio-svg-J-gA13gOpOlOpL6JsM29-g)" '
      + 'style="fill: url(&quot;#drawio-svg-J-gA13gOpOlOpL6JsM29-g&quot;);"/></svg>';
    const out = namespaceIds(raw, 'fig');
    expect(out).toContain('fill="url(#fig-g)"');
    expect(out).toContain('style="fill: url(&quot;#fig-g&quot;);"');
  });

  test('a reference to an id the figure does not define is refused', () => {
    expect(() => verifyReferences('<svg><path fill="url(#gone)"/></svg>')).toThrow(SvgError);
    expect(() => verifyReferences('<svg><path fill="url(&quot;#gone&quot;)"/></svg>'))
      .toThrow(SvgError);
    expect(() => verifyReferences('<svg><g id="a"/><use href="#a"/></svg>')).not.toThrow();
  });

  test('an unrecognised generated id is refused rather than shipped churning', () => {
    // The strip is length-bound to the nanoid draw.io writes today; if upstream
    // changes it the figure still renders, and only this check notices.
    expect(() => namespaceIds('<svg id="drawio-svg-short-gradient-a"></svg>', 'fig'))
      .toThrow(SvgError);
  });

  test('the salt comes from the output filename, so two figures cannot collide', () => {
    expect(saltFor('cloud-topology.svg')).toBe('cloud-topology');
    expect(saltFor('My Figure (2).svg')).toBe('my-figure-2');
    expect(saltFor('.svg')).toBe('drawio');
  });
});

describe('house attributes', () => {
  test('sizing is made fluid and the source marker names draw.io, not d2', () => {
    const out = applyHouseAttributes(`${ROOT}</svg>`, 'Cloud topology');
    expect(out).toStartWith(`<!-- ${SOURCE_MARK} -->`);
    expect(out).toContain('class="drawio" role="img" aria-label="Cloud topology"');
    expect(out).toContain('width="100%" style="height:auto"');
    expect(out).not.toContain('height="50px"');
  });

  test("draw.io's own root style is dropped so the tag carries one style attribute", () => {
    // Left in place it is a second style= on the same tag, and the house sizing
    // silently loses to the attribute that was already there.
    const tag = applyHouseAttributes(`${ROOT}</svg>`, 'x').match(/<svg\b[^>]*>/)![0];
    expect([...tag.matchAll(/\bstyle="/g)]).toHaveLength(1);
  });

  test('a label carrying markup characters cannot break out of the attribute', () => {
    const out = applyHouseAttributes(`${ROOT}</svg>`, 'a "b" & <c>');
    expect(out).toContain('aria-label="a &quot;b&quot; &amp; &lt;c>"');
  });
});

describe('source screening refuses what would export as foreignObject', () => {
  // The HTML-label export costs 7x the bytes, a base64 raster twin per label and
  // a drawio.com link the containment gate refuses. The output reports a count,
  // never which cell caused it, so the source is what gets screened.
  test('html=1 is named with the cell it sits on', () => {
    const xml = '<mxCell id="alb" style="shape=x;html=1;" vertex="1"/>';
    expect(screenSource(xml)).toEqual([{ cellId: 'alb', fix: 'html=1 → html=0' }]);
  });

  test('whiteSpace=wrap is caught even where html is already 0', () => {
    const xml = '<mxCell id="vpc" style="html=0;whiteSpace=wrap;" vertex="1"/>';
    expect(screenSource(xml).map((p) => p.fix))
      .toEqual(['drop whiteSpace=wrap and shorten the label']);
  });

  test('overflow=fill is caught, and a clean cell reports nothing', () => {
    expect(screenSource('<mxCell id="a" style="overflow=fill;"/>')).toHaveLength(1);
    expect(screenSource('<mxCell id="a" style="shape=mxgraph.aws4.rds;html=0;"/>')).toEqual([]);
  });

  test('a labelled object wrapper is screened like a bare cell', () => {
    expect(screenSource('<object id="o" style="html=1;" label="x"/>')[0].cellId).toBe('o');
  });
});

describe('a compressed diagram is refused rather than passed unscreened', () => {
  test('deflated payload is detected', () => {
    expect(isCompressed('<mxfile><diagram id="a" name="p">7Vpbc9o4</diagram></mxfile>'))
      .toBe(true);
  });

  test('plain XML is not', () => {
    expect(isCompressed('<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>'))
      .toBe(false);
  });
});

describe('the committed example', () => {
  const svg = readFileSync(example, 'utf-8');

  test('renders through the same self-containment gate as a d2 figure', () => {
    expect(() => verifySelfContained(svg, 0)).not.toThrow();
  });

  test('carries no foreignObject and no absolute http reference', () => {
    const found = inspect(svg);
    expect({ fo: found.foreignObjects, urls: found.externalUrls, scripts: found.scripts })
      .toEqual({ fo: 0, urls: [], scripts: 0 });
  });

  test('draws its labels as SVG text, which is what an <img> embed can render', () => {
    expect([...svg.matchAll(/<text\b/g)].length).toBeGreaterThan(8);
  });

  test('is inlinable into markdown — no blank lines and no leading indentation', () => {
    expect(svg.split('\n').some((l) => l.trim() === '' || /^[\t ]/.test(l))).toBe(false);
  });

  test('its source stays screenable and screened', () => {
    const xml = readFileSync(source, 'utf-8');
    expect(isCompressed(xml)).toBe(false);
    expect(screenSource(xml)).toEqual([]);
  });

  test('every paint-server reference in it resolves to an id it defines', () => {
    expect(() => verifyReferences(svg)).not.toThrow();
  });

  test('every id it ships is namespaced to the figure', () => {
    const ids = [...svg.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(8);
    expect(ids.filter((id) => !id.startsWith('cloud-topology-'))).toEqual([]);
  });

  test('uses real vendor stencils rather than look-alike boxes', () => {
    const xml = readFileSync(source, 'utf-8');
    for (const shape of ['mxgraph.aws4.application_load_balancer', 'mxgraph.aws4.rds']) {
      expect(xml).toContain(`resIcon=${shape}`);
    }
    expect(xml).toContain('shape=mxgraph.kubernetes.icon;prIcon=ing');
  });
});
