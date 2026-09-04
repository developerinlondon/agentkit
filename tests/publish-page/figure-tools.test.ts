import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledThemePath, renderThemed } from '../../skills/publish-page/render-html.ts';
import { chromePath, launchBrowser, rethrowLaunchFailure } from './browser-launch.ts';
import { attach, evaluate, type Session } from './devtools.ts';
import { cssRules, type Rule } from './theme-css.ts';

const themes = join(import.meta.dir, '..', '..', 'skills', 'publish-page', 'themes');
const doc = readFileSync(join(themes, 'doc.html'), 'utf8');
const deck = readFileSync(join(themes, 'deck.html'), 'utf8');

describe('figures are fitted to the screen, never stretched to the column', () => {
  // Declarations, not the literal rule text: a reformat of the theme is not a
  // regression, and asserting whitespace would report one. Rules are found by
  // what they say rather than by where they sit, so moving one is not a failure
  // either.
  function parse(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon === -1) continue;
      out[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
    }
    return out;
  }

  function only(css: string, what: string, pick: (rule: Rule) => boolean): Rule {
    const found = cssRules(css).filter(pick);
    if (found.length !== 1) throw new Error(`expected one ${what} rule, found ${found.length}`);
    return found[0];
  }

  // The same selector list also carries the print-colour rule, so the sizing
  // rule is picked by what it declares rather than by which one comes first.
  function sizing(css: string): Rule {
    return only(css, 'figure sizing', ({ selectors, body }) => {
      const decls = parse(body);
      // startsWith, not includes: `.fig-lightbox .figure > svg:not(.edges)`
      // contains the same text and declares a width of its own.
      return selectors.startsWith('.figure > svg:not(.edges)')
        && ('display' in decls || 'width' in decls || 'max-width' in decls);
    });
  }

  const VIEWPORT_ARMS = [
    '.figure > .fig-viewport > svg:not(.edges)',
    '.figure > .fig-viewport > p > svg:not(.edges)',
  ];

  for (const theme of [['doc', doc], ['deck', deck]] as const) {
    const [name, css] = theme;
    test(`${name} caps the figure svg by height as well as width, and fixes neither`, () => {
      // width: 100% upscaled every figure narrower than the column: a 757px
      // sketch rendered at 977px and its height grew with it. Nothing then
      // bounded the height, so a 717x1292 sketch ran 1.4 screens tall.
      expect({ name, ...parse(sizing(css).body) }).toEqual({
        name,
        'display': 'block',
        'max-width': '100%',
        'max-height': '60vh',
        'width': 'auto',
        'height': 'auto',
        'margin-inline': 'auto',
      });
    });

    test(`${name} applies the cap inside the toolbar's scroll box too`, () => {
      // The script wraps the svg in .fig-viewport, which breaks the `>` chain
      // the two original arms depend on. Without these the cap would hold only
      // until the toolbar decorated the figure.
      const { selectors } = sizing(css);
      for (const arm of VIEWPORT_ARMS) {
        expect({ name, arm, covered: selectors.includes(arm) }).toEqual({ name, arm, covered: true });
      }
    });

    test(`${name} lifts the height cap in full screen`, () => {
      // Full screen is where a reader goes to escape the cap, so a 60vh figure
      // there is the bug, not the fix. Print is checked in the browser instead:
      // these selectors tie on specificity, so what the print block declares is
      // no evidence at all about what a printer resolves.
      const expanded = only(css, 'lightbox sizing', ({ selectors }) => selectors.includes('.fig-lightbox .figure > svg'));
      expect({ name, lightbox: parse(expanded.body) }).toEqual({
        name,
        lightbox: { 'max-width': 'none', 'max-height': 'none', 'width': 'auto', 'height': 'auto' },
      });
    });

    test(`${name} ships all four figure controls and clamps the zoom`, () => {
      for (const action of ['out', 'in', 'reset', 'full']) {
        expect({ name, action, shipped: css.includes(`["${action}", `) }).toEqual({ name, action, shipped: true });
      }
      expect(css).toContain('const ZOOM_STEP = 1.25;');
      expect(css).toContain('const ZOOM_MIN = 0.5;');
      expect(css).toContain('const ZOOM_MAX = 4;');
    });
  }
});

// The CSS above says what the theme declares. Only a browser says what a reader
// is served: the fit is a constraint resolution over an intrinsic ratio, and the
// zoom is a script measuring its own layout. Both are read off real boxes here.
const chrome = chromePath();
if (!chrome) {
  console.error(
    'SKIPPED the figure-fit measurements in tests/publish-page/figure-tools.test.ts: no '
      + 'Chrome/Chromium found, so nothing here measured what a reader is served. '
      + 'Set AGENTKIT_CHROMIUM to a browser binary.',
  );
}

// Two figures whose fit is decided by different caps: the tall one is bounded by
// the viewport height, the wide one by the column. Both carry the root the
// renderers write, inline style included, so the cascade under test is the real
// one.
function figureSvg(width: number, height: number, id: string): string {
  return `<svg role="img" aria-label="${id}" id="${id}" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" `
    + `style="max-width:100%;height:auto"><rect width="${width}" height="${height}" fill="#182233"/></svg>`;
}

const FIGURES = '<h1>figures</h1>'
  + `<div class="figure">${figureSvg(717, 1292, 'tall')}<div class="figcaption">tall</div></div>`
  + `<div class="figure">${figureSvg(2500, 800, 'wide')}<div class="figcaption">wide</div></div>`
  // A deck splits on <hr>, and the space-key control needs a slide to advance to.
  + '<hr><h2>second</h2>';

const DECORATED_MS = 20_000;
const CASE_TIMEOUT_MS = 180_000;
const ZOOM_TWICE = 1.25 * 1.25;

interface Box {
  w: number;
  h: number;
}

interface Fit {
  viewport: Box;
  tall: Box;
  wide: Box;
  column: number;
}

interface Shrunk {
  zoom: string;
  svg: Box;
  boxHeight: number;
}

interface Interaction {
  fit: Box;
  cursorFit: string;
  cursorZoomed: string;
  shrunk: Shrunk;
  zoom: string;
  zoomed: Box;
  boxHeight: number;
  boxScrollHeight: number;
  pageWidth: number;
  zoomedPageWidth: number;
  reset: Box;
  lightbox: Box;
  lightboxTools: string[];
  closed: boolean;
}

interface Frame {
  maxHeight: string;
  tools: string;
  overflow: string;
  svgHeight: number;
  boxHeight: number;
}

interface MediaState {
  fitted: Frame;
  zoomed: Frame;
}

interface Keys {
  slides: number;
  zoomOnButton: string;
  slideOnButton: number;
  zoomOnBody: string;
  slideOnBody: number;
}

interface Measured {
  wide: Fit;
  narrow: Fit;
  acted: Interaction;
  screen: MediaState;
  paper: MediaState;
  keys: Keys | null;
  errors: string[];
}

const FIT_PROBE = `(() => {
  const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    tall: box('tall'),
    wide: box('wide'),
    column: document.getElementById('wide').parentElement.clientWidth,
  });
})()`;

// One pass, because every step reads the state the one before it left: the box
// the toolbar locked, the page width it must not have changed, the size reset
// has to return to.
const ACT_PROBE = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const svg = document.getElementById('tall');
  const fig = svg.closest('.figure');
  const tool = (name) => fig.querySelector('[data-fig-tool="' + name + '"]');
  const viewport = fig.querySelector('.fig-viewport');
  const out = {
    fit: box(svg),
    pageWidth: document.documentElement.scrollWidth,
    cursorFit: getComputedStyle(fig).cursor,
  };
  tool('in').click();
  tool('in').click();
  out.zoom = fig.dataset.figZoom;
  out.zoomed = box(svg);
  out.zoomedPageWidth = document.documentElement.scrollWidth;
  out.boxHeight = Math.round(viewport.getBoundingClientRect().height);
  out.boxScrollHeight = viewport.scrollHeight;
  out.cursorZoomed = getComputedStyle(fig).cursor;
  tool('reset').click();
  out.reset = box(svg);
  tool('out').click();
  tool('out').click();
  out.shrunk = { zoom: fig.dataset.figZoom, svg: box(svg), boxHeight: Math.round(viewport.getBoundingClientRect().height) };
  tool('reset').click();
  tool('full').click();
  const copy = document.querySelector('.fig-lightbox .figure');
  out.lightbox = box(copy.querySelector('svg[role="img"]'));
  out.lightboxTools = [...copy.querySelectorAll('.fig-tool')].map((b) => b.dataset.figTool);
  dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  out.closed = document.querySelector('.fig-lightbox').hidden;
  return JSON.stringify(out);
})()`;

// Computed style, not the rule text. The print and screen rules tie on
// specificity, so only the resolved value says which one a printer takes. Both
// states, because they prove different rules: the cap and the toolbar are read
// fitted, the scroll box only says anything once there is overflow to contain.
const MEDIA_PROBE = `(() => {
  const svg = document.getElementById('tall');
  const fig = svg.closest('.figure');
  const viewport = fig.querySelector('.fig-viewport');
  const frame = () => ({
    maxHeight: getComputedStyle(svg).maxHeight,
    tools: getComputedStyle(fig.querySelector('.fig-tools')).display,
    overflow: getComputedStyle(viewport).overflowY,
    svgHeight: Math.round(svg.getBoundingClientRect().height),
    boxHeight: Math.round(viewport.getBoundingClientRect().height),
  });
  const fitted = frame();
  fig.querySelector('[data-fig-tool="in"]').click();
  fig.querySelector('[data-fig-tool="in"]').click();
  const zoomed = frame();
  fig.querySelector('[data-fig-tool="reset"]').click();
  return JSON.stringify({ fitted, zoomed });
})()`;

const RESET_PROBE = `(() => {
  const fig = document.getElementById('tall').closest('.figure');
  fig.querySelector('[data-fig-tool="reset"]').click();
  return fig.dataset.figZoom;
})()`;

const activeSlide = `[...document.querySelectorAll('.slide')].findIndex((s) => s.classList.contains('active'))`;

function focusProbe(what: 'button' | 'body'): string {
  const target = what === 'button'
    ? `document.getElementById('tall').closest('.figure').querySelector('[data-fig-tool="in"]')`
    : 'document.body';
  return `(() => { const t = ${target}; t.setAttribute('tabindex', '-1'); t.focus(); return t === document.activeElement; })()`;
}

const KEY_STATE_PROBE = `JSON.stringify({
  zoom: document.getElementById('tall').closest('.figure').dataset.figZoom,
  slide: ${activeSlide},
  slides: document.querySelectorAll('.slide').length,
})`;

// A synthetic KeyboardEvent never activates a button, so the case would pass on
// a deck that swallowed the key. Only a real key event through the input queue
// exercises the browser's own default action.
async function pressSpace(session: Session): Promise<void> {
  const key = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await session.send('Input.dispatchKeyEvent', { type: 'char', text: ' ', unmodifiedText: ' ', ...key });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await Bun.sleep(100);
}

async function resize(session: Session, width: number, height: number): Promise<void> {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

// The toolbar is built by the theme's own script; asking before it has run reads
// an undecorated page and reports the old behaviour as the new one.
async function awaitDecoration(session: Session, subject: string): Promise<void> {
  const deadline = Date.now() + DECORATED_MS;
  while (Date.now() < deadline) {
    if (await evaluate(session, `document.querySelectorAll('.figure .fig-tool').length === 8`)) return;
    await Bun.sleep(50);
  }
  const state = await evaluate(
    session,
    `JSON.stringify({ readyState: document.readyState, figures: document.querySelectorAll('.figure').length,`
      + ` tools: document.querySelectorAll('.fig-tool').length })`,
  );
  throw new Error(`${subject}: the figure toolbars never appeared in ${DECORATED_MS}ms\npage: ${state}`);
}

async function read(session: Session, probe: string): Promise<any> {
  return JSON.parse(await evaluate(session, probe) as string);
}

async function measureMedia(session: Session): Promise<[MediaState, MediaState]> {
  const screen = await read(session, MEDIA_PROBE) as MediaState;
  await session.send('Emulation.setEmulatedMedia', { media: 'print' });
  const paper = await read(session, MEDIA_PROBE) as MediaState;
  await session.send('Emulation.setEmulatedMedia', { media: '' });
  return [screen, paper];
}

// Space on a focused zoom button must zoom and leave the deck where it is; from
// the body it must still advance. Both halves in one pass, so a deck that
// ignored the key everywhere cannot pass the first on its own.
async function measureKeys(session: Session): Promise<Keys> {
  await evaluate(session, focusProbe('button'));
  await pressSpace(session);
  const onButton = await read(session, KEY_STATE_PROBE);
  await evaluate(session, RESET_PROBE);
  await evaluate(session, focusProbe('body'));
  await pressSpace(session);
  const onBody = await read(session, KEY_STATE_PROBE);
  return {
    slides: onButton.slides,
    zoomOnButton: onButton.zoom,
    slideOnButton: onButton.slide,
    zoomOnBody: onBody.zoom,
    slideOnBody: onBody.slide,
  };
}

async function measure(template: 'doc' | 'deck'): Promise<Measured> {
  const html = await renderThemed({
    source: FIGURES,
    isMd: false,
    template,
    title: 'figures',
    themePath: bundledThemePath(template),
  });
  const launch = await launchBrowser({ binary: chrome as string });
  const file = join(launch.profile, 'figures.html');
  writeFileSync(file, html);
  let session: Session | undefined;
  try {
    session = await attach(launch.endpoint);
    await Promise.all([session.send('Runtime.enable'), session.send('Log.enable'), session.send('Page.enable')]);
    await resize(session, 1280, 900);
    await session.send('Page.navigate', { url: `file://${file}` });
    await awaitDecoration(session, template);
    const wide = await read(session, FIT_PROBE) as Fit;
    const acted = await read(session, ACT_PROBE) as Interaction;
    const [screen, paper] = await measureMedia(session);
    const keys = template === 'deck' ? await measureKeys(session) : null;
    await resize(session, 768, 1024);
    // A viewport change is applied on the compositor's own schedule, so the
    // reading waits for the height the override asked for rather than a delay.
    const deadline = Date.now() + DECORATED_MS;
    while (Date.now() < deadline && await evaluate(session, 'innerHeight') !== 1024) await Bun.sleep(50);
    const narrow = await read(session, FIT_PROBE) as Fit;
    return { wide, narrow, acted, screen, paper, keys, errors: session.logs };
  } finally {
    session?.close();
    await launch.close();
  }
}

const pending = new Map<string, Promise<Measured>>();
function measured(template: 'doc' | 'deck'): Promise<Measured> {
  const held = pending.get(template);
  if (held) return held;
  const started = measure(template).catch((error: unknown) =>
    rethrowLaunchFailure(error, `${template}: the figure-fit measurements`)
  );
  pending.set(template, started);
  return started;
}

const aspect = (box: Box) => box.w / box.h;

describe.if(chrome !== null)('a figure in a real browser', () => {
  for (const template of ['doc', 'deck'] as const) {
    test(`${template}: a 717x1292 figure fits the screen at both viewports, aspect kept`, async () => {
      const { wide, narrow, errors } = await measured(template);
      expect({ template, errors }).toEqual({ template, errors: [] });
      for (const [where, fit] of [['1280x900', wide], ['768x1024', narrow]] as const) {
        // 60vh, resolved by the browser rather than computed here.
        expect({ template, where, fits: fit.tall.h <= Math.ceil(fit.viewport.h * 0.6) })
          .toEqual({ template, where, fits: true });
        expect({ template, where, distorted: Math.abs(aspect(fit.tall) - 717 / 1292) > 0.01 })
          .toEqual({ template, where, distorted: false });
      }
      expect({ template, tall: wide.tall }).toEqual({ template, tall: { w: 300, h: 540 } });
    }, CASE_TIMEOUT_MS);

    test(`${template}: a 2500x800 figure still fills the column`, async () => {
      // The height cap must not shrink a figure the width cap already fits: it
      // would be a fit-to-screen change that quietly undid the column fill.
      const { wide } = await measured(template);
      expect({ template, ...wide.wide }).toEqual({ template, w: wide.column, h: Math.round(wide.column * 800 / 2500) });
    }, CASE_TIMEOUT_MS);

    test(`${template}: zooming in twice enlarges the figure without widening the page`, async () => {
      const { acted } = await measured(template);
      expect({ template, zoom: acted.zoom }).toEqual({ template, zoom: String(ZOOM_TWICE) });
      expect({ template, grew: acted.zoomed.h > acted.fit.h }).toEqual({ template, grew: true });
      expect({ template, factor: Math.abs(acted.zoomed.h / acted.fit.h - ZOOM_TWICE) < 0.02 })
        .toEqual({ template, factor: true });
      // The whole point of the scroll box: the page is the same width, and the
      // figure's own footprint is the same height, with the overflow scrollable.
      expect({ template, width: acted.zoomedPageWidth }).toEqual({ template, width: acted.pageWidth });
      expect({ template, footprint: Math.abs(acted.boxHeight - acted.fit.h) <= 1 })
        .toEqual({ template, footprint: true });
      expect({ template, scrollable: acted.boxScrollHeight > acted.boxHeight })
        .toEqual({ template, scrollable: true });
    }, CASE_TIMEOUT_MS);

    test(`${template}: reset returns the figure to its fitted size`, async () => {
      const { acted } = await measured(template);
      expect({ template, ...acted.reset }).toEqual({ template, ...acted.fit });
    }, CASE_TIMEOUT_MS);

    test(`${template}: zooming out shrinks the box, it does not leave a gap under the figure`, async () => {
      // The box footprint tracks the smaller of fitted and scaled. Locking it at
      // the fitted height left 0.5x sitting in 540px of empty ground.
      const { acted } = await measured(template);
      const out = 1 / (1.25 * 1.25);
      expect({ template, zoom: acted.shrunk.zoom }).toEqual({ template, zoom: String(out) });
      expect({ template, shrank: acted.shrunk.svg.h < acted.fit.h }).toEqual({ template, shrank: true });
      expect({ template, gap: acted.shrunk.boxHeight - acted.shrunk.svg.h <= 1 })
        .toEqual({ template, gap: true });
    }, CASE_TIMEOUT_MS);

    test(`${template}: the zoom-in cursor goes away once the figure is zoomed`, async () => {
      // Clicking a zoomed figure pans it; the open handler is guarded, so the
      // cursor was the only thing still promising an expand.
      const { acted } = await measured(template);
      expect({ template, fitted: acted.cursorFit, zoomed: acted.cursorZoomed })
        .toEqual({ template, fitted: 'zoom-in', zoomed: 'default' });
    }, CASE_TIMEOUT_MS);

    test(`${template}: print resolves the cap off, the toolbar away and the box unclipped`, async () => {
      // These selectors tie with the screen ones on specificity, so source order
      // decides and only a resolved value is evidence. Placed above them, the
      // print block declared all three and won none.
      const { screen, paper } = await measured(template);
      expect({ template, ...screen.fitted }).toEqual({
        template,
        maxHeight: '540px',
        tools: 'flex',
        overflow: 'auto',
        svgHeight: 540,
        boxHeight: 540,
      });
      expect({ template, ...paper.fitted }).toEqual({
        template,
        maxHeight: 'none',
        tools: 'none',
        overflow: 'visible',
        svgHeight: 1292,
        boxHeight: 1292,
      });
      // Screen locks the box to the fitted height and scrolls the rest; paper
      // cannot scroll, so there the box grows instead of clipping.
      expect({ template, clipped: screen.zoomed.boxHeight < screen.zoomed.svgHeight })
        .toEqual({ template, clipped: true });
      expect({ template, clipped: paper.zoomed.boxHeight < paper.zoomed.svgHeight })
        .toEqual({ template, clipped: false });
    }, CASE_TIMEOUT_MS);

    test(`${template}: full screen opens at natural size, zoomable, and Escape closes it`, async () => {
      // The 60vh cap is the inline read. Carrying it into the lightbox would
      // leave a reader no way at all to see the figure at its own size.
      const { acted } = await measured(template);
      expect({ template, ...acted.lightbox }).toEqual({ template, w: 717, h: 1292 });
      expect({ template, tools: acted.lightboxTools }).toEqual({ template, tools: ['out', 'in', 'reset'] });
      expect({ template, closed: acted.closed }).toEqual({ template, closed: true });
    }, CASE_TIMEOUT_MS);
  }

  test('deck: Space on a focused zoom button zooms instead of advancing the slide', async () => {
    // The deck's window handler preventDefaulted Space wherever focus was, so a
    // keyboard reader pressing it on the zoom button got a slide change and no
    // zoom. From the body it must still advance, or the guard has just disabled
    // the key.
    const { keys } = await measured('deck');
    expect({ slides: keys?.slides }).toEqual({ slides: 2 });
    expect({ zoom: keys?.zoomOnButton, slide: keys?.slideOnButton }).toEqual({ zoom: '1.25', slide: 0 });
    expect({ zoom: keys?.zoomOnBody, slide: keys?.slideOnBody }).toEqual({ zoom: '1', slide: 1 });
  }, CASE_TIMEOUT_MS);
});
