import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromePath, launchBrowser, rethrowLaunchFailure } from '../../publish-page/browser-launch.ts';
import { attach, evaluate, type Session } from '../../publish-page/devtools.ts';
import { placeholderIds } from '../../../scripts/sync-hugo-diagram-icons.ts';

// The Hugo diagrams module is the docs path for figures: specs are data, the
// build is the renderer, and the build is also the validator. These cases
// build the module's own example site and then break it on purpose, because a
// check that never fails proves nothing about the figures it waves through.

const ROOT = join(import.meta.dir, '..', '..', '..');
const MODULE_PARENT = join(ROOT, 'hugo');
const EXAMPLE = join(ROOT, 'hugo', 'diagrams', 'exampleSite');
const HUGO = process.env.HUGO_BIN ?? Bun.which('hugo');
const scratch = mkdtempSync(join(tmpdir(), 'agentkit-hugo-diagrams-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

if (!HUGO) {
  throw new Error('tests/diagram/hugo/module.test.ts needs Hugo >= 0.164 on PATH (or HUGO_BIN); CI installs it');
}

interface Build {
  ok: boolean;
  log: string;
  site: string;
  html: string;
}

let counter = 0;

// Each build gets its own copy so a mutation in one case cannot leak into another.
function build(mutate?: (site: string) => void, minify = true): Build {
  const site = join(scratch, `site-${++counter}`);
  cpSync(EXAMPLE, site, { recursive: true });
  // The example points at the module relative to itself; a copy has to name it.
  edit(site, 'hugo.yaml', 'themesDir: ../..', `themesDir: ${MODULE_PARENT}`);
  mutate?.(site);
  const run = Bun.spawnSync(
    [HUGO as string, ...(minify ? ['--minify'] : []), '-s', site, '-d', join(site, 'public')],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const log = `${run.stdout.toString()}${run.stderr.toString()}`;
  let html = '';
  try {
    html = readFileSync(join(site, 'public', 'index.html'), 'utf8');
  } catch {}
  return { ok: run.exitCode === 0, log, site, html };
}

function edit(site: string, rel: string, from: string, to: string) {
  const path = join(site, rel);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`fixture drift: ${rel} no longer contains ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, to));
}

function figures(html: string): string[] {
  return [...html.matchAll(/<figure class="?dg[\s\S]*?<\/figure>/g)].map((m) => m[0]);
}

const good = build();

describe('the example site builds', () => {
  test('without errors or layout warnings', () => {
    expect(good.log).not.toMatch(/ERROR|WARN/);
    expect(good.ok).toBe(true);
  });

  test('every figure is one accessible inline SVG with a text version', () => {
    const figs = figures(good.html);
    expect(figs.length).toBe(2);
    for (const fig of figs) {
      // A second <svg> inside a figure makes the minifier end the figure early.
      expect(fig.match(/<svg/g)?.length).toBe(1);
      expect(fig).toMatch(/role="?img/);
      expect(fig).toMatch(/<title id=[^>]+>[^<]+<\/title><desc id=/);
      expect(fig).toContain('Text version');
    }
    expect(figs[0]).toContain('<li>Browser → Edge</li>');
    expect(figs[1]).toMatch(/If approved:<ol><li>Approver → API: approve/);
  });

  test('architecture.json carries every spec and the page that uses it', () => {
    const json = JSON.parse(readFileSync(join(good.site, 'public', 'architecture.json'), 'utf8'));
    const names = json.diagrams.map((d: { name: string }) => d.name).sort();
    expect(names).toEqual(['checkout', 'refund']);
    for (const d of json.diagrams) expect(d.pages).toEqual(['https://example.org/']);
  });

  test('font names may use any script and the system-font keywords stay bare', () => {
    const result = build((s) => edit(s, 'hugo.yaml', 'radius: 6', 'radius: 6\n      sans: [Söhne, -apple-system, system-ui]'));
    expect(result.html).toContain('--dg-sans:"Söhne",-apple-system,system-ui');
  });

  test('a Bootstrap-style dark attribute is an accepted dark selector', () => {
    const result = build((s) => edit(s, 'hugo.yaml', 'dark_selector: media', 'dark_selector: "[data-bs-theme=dark]"'));
    expect(result.html).toMatch(/\[data-bs-theme=dark\]\{--dg-/);
  });

  test('font names are quoted by the module, generic families left bare', () => {
    const result = build((s) => edit(s, 'hugo.yaml', 'radius: 6', 'radius: 6\n      sans: [Inter Display, system-ui]'));
    expect(result.html).toContain('--dg-sans:"Inter Display",system-ui');
  });

  test('project tokens become custom properties, dark values in the configured query', () => {
    expect(good.html).toContain('--dg-accent:#5b3cc4');
    expect(good.html).toContain('--dg-radius:6px');
    expect(good.html).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\{:root\{[^}]*--dg-accent:#b6a4ff/);
  });

  test('a project icon is drawn as a normalised stroke group, brand art is left alone', () => {
    const checkout = figures(good.html)[0];
    expect(checkout).toMatch(/<g class="dg-icon dg-icon-stroke"[^>]*><rect[^>]*rx="?5/);
    // Cloudflare's own colours are part of the mark; the theme must not repaint it.
    const brand = checkout.match(/<g class="dg-icon dg-icon-color"[^>]*>([\s\S]*?)<\/g>/)?.[1] ?? '';
    expect(brand).toMatch(/fill="#[0-9a-fA-F]{6}"/);
    expect(brand).not.toContain('currentColor');
  });
});

describe('the build refuses what it cannot draw faithfully', () => {
  const cases: [string, (site: string) => void, RegExp][] = [
    [
      'an edge to a node that does not exist',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: nowhere }'),
      /edge to "nowhere": no such node or group/,
    ],
    [
      'a duplicate id',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ id: edge,', '{ id: browser,'),
      /duplicate id "browser"/,
    ],
    [
      'an icon no pack has',
      (s) => edit(s, 'data/diagrams/checkout.yaml', 'icon: inbox', 'icon: no-such-icon'),
      /icon "no-such-icon" is not in heroicons, simple-icons or logos/,
    ],
    [
      'an icon name two packs share',
      (s) => edit(s, 'data/diagrams/checkout.yaml', 'icon: logos/postgresql', 'icon: postgresql'),
      /icon "postgresql" is in simple-icons and logos; write pack\/name/,
    ],
    [
      'a project icon whose viewBox has three numbers',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8"><rect width="8" height="8"/></svg>'),
      /icon "@acme\/widget".*no valid viewBox/,
    ],
    [
      'a project icon whose viewBox has five numbers',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8 8"><rect width="8" height="8"/></svg>'),
      /icon "@acme\/widget".*no valid viewBox/,
    ],
    [
      'a project icon whose viewBox exponent is out of range',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 1e400 8"><rect width="8" height="8"/></svg>'),
      /icon "@acme\/widget".*no valid viewBox/,
    ],
    [
      'a project icon whose viewBox width has hundreds of digits',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), `<svg viewBox="0 0 ${'9'.repeat(400)} 8"><rect width="8" height="8"/></svg>`),
      /icon "@acme\/widget".*no valid viewBox/,
    ],
    [
      'a project icon whose viewBox is so wide the icon would draw invisibly',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 9e9 8"><rect width="8" height="8"/></svg>'),
      /icon "@acme\/widget".*no valid viewBox/,
    ],
    [
      'a project icon whose viewBox origin is far off the canvas',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="-999999999e9 0 8 8"><rect width="8" height="8"/></svg>'),
      /icon "@acme\/widget".*no valid viewBox/,
    ],
    [
      'a project icon whose viewBox has no width',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 0 8"><rect width="8" height="8"/></svg>'),
      /icon "@acme\/widget".*no valid viewBox/,
    ],
    [
      'a project icon file that is missing',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '"@acme/widget"', '"@acme/gadget"'),
      /icon "@acme\/gadget": assets\/icons\/acme\/gadget.svg does not exist/,
    ],
    [
      'a project icon that nests an <svg>',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><svg><rect/></svg></svg>'),
      /a nested, repeated or misplaced <svg>/,
    ],
    [
      'a mermaid code block',
      (s) => writeFileSync(join(s, 'content/_index.md'), '---\ntitle: x\n---\n\n```mermaid\nflowchart LR\n A-->B\n```\n'),
      /a ```mermaid block/,
    ],
    [
      'labels too small for the configured column',
      (s) => edit(s, 'hugo.yaml', 'content_width: 640', 'content_width: 300'),
      /smallest label shows at [0-9.]+px in a 300px column \(floor 8px\)/,
    ],
    [
      'a flow edge that loops to its own node without sides',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker }\n  - { from: api, to: api }'),
      /edge api → api loops to its own node/,
    ],
    [
      'a flow self-loop whose sides would cut through its own box',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker }\n  - { from: api, to: api, exit: right, enter: top, exit_at: -8, enter_at: 8 }'),
      /edge api → api loops to its own node; draw it with exit and enter on the same side/,
    ],
    [
      'a self-loop whose two points nearly coincide',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker }\n  - { from: api, to: api, exit: right, enter: right, exit_at: 0, enter_at: 0.5 }'),
      /a loop needs exit_at and enter_at at least 12px apart/,
    ],
    [
      'a self-loop that leaves from off its node',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker }\n  - { from: api, to: api, exit: right, enter: right, exit_at: -100, enter_at: 0 }'),
      /both within its right side/,
    ],
    [
      'a self-loop that returns to a point off its node',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker }\n  - { from: api, to: api, exit: right, enter: right, exit_at: 0, enter_at: 100 }'),
      /both within its right side/,
    ],
    [
      'a label pinned to a segment the route does not have',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker, label: x, label_segment: 4 }'),
      /diagram "checkout": edge queue → worker: label_segment 4, but the route has 1 segments/,
    ],
    [
      'a project icon that carries a script',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><script>alert(1)</script></svg>'),
      /project icons may hold only/,
    ],
    [
      'a project icon that carries a stylesheet',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><style>body{display:none}</style><rect/></svg>'),
      /<style>; project icons may hold only/,
    ],
    [
      'a project icon with an event handler',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect onload="x()"/></svg>'),
      /project icons may hold only/,
    ],
    [
      'a project icon with an event handler glued to the previous attribute',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect width="2"onclick="x()"/></svg>'),
      /project icons may hold only/,
    ],
    [
      'a project icon whose animation carries a slash-separated handler',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect><animate/onbegin=x() attributeName="x"/></rect></svg>'),
      /project icons may hold only/,
    ],
    [
      'a project icon with an HTML image inside',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><img src="x"/></svg>'),
      /<img>; project icons may hold only/,
    ],
    [
      'a project icon that links outside itself',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><use href="https://example.org/x.svg#a"/></svg>'),
      /href on <use> \(only a gradient may link/,
    ],
    [
      'a project icon that closes the root early with </svg/>',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect/></svg/><rect/></svg>'),
      /not well-formed XML|outside the <svg> root|misplaced <svg>/,
    ],
    [
      'a font token whose quotes nest',
      (s) => edit(s, 'hugo.yaml', 'radius: 6', `radius: 6\n      sans: "\\"a'b\\"'"`),
      /tokens.sans: .* is not a font name/,
    ],
    [
      'a project icon with a nested self-closing <svg/>',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><svg/><rect width="8" height="8"/></svg>'),
      /a nested, repeated or misplaced <svg>/,
    ],
    [
      'a project icon whose handler follows a slash',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect/onclick="alert(1)" width="8" height="8"/></svg>'),
      /project icons may hold only/,
    ],
    [
      'a project icon that paints from an outside URL',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect fill="url(https://example.org/x)"/></svg>'),
      /fill=.*not a valid fill value/,
    ],
    [
      'a project icon that is not well-formed',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><g><rect/></svg>'),
      /not well-formed XML|never closed|closes nothing open/,
    ],
    [
      'a dark selector outside the fixed set',
      (s) => edit(s, 'hugo.yaml', 'dark_selector: media', "dark_selector: \"[data-x='a]\""),
      /dark_selector: .* is not one of/,
    ],
    [
      'a project icon with a shape inside its title',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><title><rect width="2" height="2"/></title><rect width="3" height="3"/></svg>'),
      /<rect> inside <title>, which may hold text only/,
    ],
    [
      'a project icon with a path inside its desc',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><desc><path d="M0 0h4"/></desc></svg>'),
      /<path> inside <desc>, which may hold text only/,
    ],
    [
      'a project icon with a path inside its title',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><title><path d="M0 0h4"/></title></svg>'),
      /<path> inside <title>, which may hold text only/,
    ],
    [
      'a project icon with a group inside its desc',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><desc><g/></desc></svg>'),
      /<g> inside <desc>, which may hold text only/,
    ],
    [
      'a project icon whose paint hides url( behind an entity',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="u&#114;l(http://example.org/x.svg#g)"/></svg>'),
      /project icons may hold only/,
    ],
    [
      'a project icon whose mask hides url( behind an entity',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect width="8" height="8" mask="u&#x72;l(http://example.org/m.svg#m)"/></svg>'),
      /project icons may hold only/,
    ],
    [
      'a project icon whose clip-path hides url( behind a CSS escape',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect width="8" height="8" clip-path="\\75 rl(http://example.org/c.svg#c)"/></svg>'),
      /clip-path=.*not a valid clip-path value/,
    ],
    [
      'a project icon that borrows a page class',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect class="dg-node" width="8" height="8"/></svg>'),
      /attribute class; project icons may hold only/,
    ],
    [
      'a style declaration whose value the grammar refuses',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect width="8" height="8" style="fill:var(--brand);stroke:#000"/></svg>'),
      /style fill:var\(--brand\) \(not a valid fill value\)/,
    ],
    [
      'a link from anything but a gradient',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><defs><rect id="a"/></defs><path href="#a" d="M0 0h8"/></svg>'),
      /href on <path> \(only a gradient may link/,
    ],
    [
      'a gradient that links outside its file',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><linearGradient id="g" href="https://example.org/x.svg#s"/><rect width="8" height="8" fill="url(#g)"/></svg>'),
      /href=.*not a valid href value/,
    ],
    [
      'a loop on the rounded side of a pill',
      (s) => {
        edit(s, 'data/diagrams/checkout.yaml', '{ id: queue, label: Queue,', '{ id: queue, label: Queue, shape: pill,');
        edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker }\n  - { from: queue, to: queue, exit: right, enter: right, exit_at: -8, enter_at: 8 }');
      },
      /a pill's rounded right side cannot hold a loop; use top or bottom/,
    ],
    [
      'a gradient that links to a gradient not defined before it',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><linearGradient id="g" href="#later"/><linearGradient id="later"><stop offset="0" stop-color="red"/></linearGradient><rect width="8" height="8" fill="url(#g)"/></svg>'),
      /a gradient href #later that names no gradient defined before it/,
    ],
    [
      'a style value that hides a second colon',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect width="8" height="8" style="fill:url(http://example.org/x.svg#g)"/></svg>'),
      /style fill:url\(http:\/\/example.org\/x.svg#g\) \(not a valid fill value\)/,
    ],
    [
      'a gradient that links to an id the icon never defines',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><linearGradient id="g" href="#missing"/><rect width="8" height="8" fill="url(#g)"/></svg>'),
      /a gradient href #missing that names no gradient defined before it/,
    ],
    [
      'a loop on a pill whose top is all curve',
      (s) => {
        edit(s, 'data/diagrams/checkout.yaml', '{ id: queue, label: Queue,', '{ id: queue, label: Queue, shape: pill, w: 50, h: 70,');
        edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker }\n  - { from: queue, to: queue, exit: top, enter: top, exit_at: -8, enter_at: 8 }');
      },
      /this pill's top side is all curve, with no straight run to hold a loop/,
    ],
    [
      'a font token that ends its declaration',
      (s) => edit(s, 'hugo.yaml', 'radius: 6', 'radius: 6\n      sans: "Inter; color: red"'),
      /tokens.sans: .* is not a font name/,
    ],
    [
      'a project icon with content after its closing tag',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect/></svg>\nexported by a tool\n'),
      /not well-formed XML|outside a title or desc/,
    ],
    [
      'a font token with an unbalanced quote',
      (s) => edit(s, 'hugo.yaml', 'radius: 6', `radius: 6\n      sans: '"Inter'`),
      /tokens.sans: .* is not a font name/,
    ],
    [
      'an unknown token',
      (s) => edit(s, 'hugo.yaml', 'radius: 6', 'radius: 6\n      shadow: 2'),
      /params.diagrams.tokens.shadow: unknown token/,
    ],
    [
      'a token value that would escape its declaration',
      (s) => edit(s, 'hugo.yaml', 'accent: "#5b3cc4"', 'accent: "red;}body{display:none"'),
      /params.diagrams.tokens.light.accent: .* is not a colour/,
    ],
  ];

  for (const [name, mutate, message] of cases) {
    test(name, () => {
      const result = build(mutate);
      expect(result.ok).toBe(false);
      expect(result.log).toMatch(message);
    });
  }
});

describe('edges of the rules', () => {
  const gradient = (id: string) =>
    `<svg viewBox="0 0 8 8"><defs><linearGradient id="${id}"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect width="8" height="8" fill="url(#${id})"/></svg>`;
  const ids = (html: string) => [...html.matchAll(/\sid="?([^"\s>]+)/g)].map((m) => m[1]);

  test('icon ids are prefixed per drawn instance and url(#id) follows', () => {
    const result = build((s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), gradient('g')));
    expect(result.log).not.toMatch(/ERROR/);
    const checkout = figures(result.html)[0];
    expect(checkout).toContain('<linearGradient id="dg1-checkout-n4-0-g">');
    expect(checkout).toContain('fill="url(#dg1-checkout-n4-0-g)"');
    expect(checkout).not.toMatch(/id="g"/);
  });

  test('an icon id equal to a module marker id cannot capture the marker', () => {
    const result = build((s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), gradient('dg2-refund-m-ink')));
    const all = ids(result.html);
    expect(all.filter((id) => id === 'dg2-refund-m-ink')).toHaveLength(1);
    expect(new Set(all).size).toBe(all.length);
  });

  test('two icons that both use id "a", and one icon drawn twice, keep their ids apart', () => {
    const result = build((s) => {
      writeFileSync(join(s, 'assets/icons/acme/widget.svg'), gradient('a'));
      writeFileSync(join(s, 'assets/icons/acme/gadget.svg'), gradient('a'));
      edit(s, 'data/diagrams/checkout.yaml', 'icon: inbox', 'icon: "@acme/gadget"');
      edit(s, 'data/diagrams/checkout.yaml', 'icon: user', 'icon: "@acme/widget"');
    });
    expect(result.log).not.toMatch(/ERROR/);
    const all = ids(result.html);
    expect(new Set(all).size).toBe(all.length);
    for (const node of ['n0', 'n3', 'n4']) {
      const id = `dg1-checkout-${node}-0-a`;
      expect(all).toContain(id);
      expect(result.html).toContain(`fill="url(#${id})"`);
    }
  });

  test('a gradient written open-and-closed with no stops takes the stops it links to', () => {
    const result = build((s) =>
      writeFileSync(
        join(s, 'assets/icons/acme/widget.svg'),
        '<svg viewBox="0 0 8 8"><linearGradient id="s"><stop offset="0" stop-color="red"/></linearGradient><linearGradient id="g" href="#s"></linearGradient><rect width="8" height="8" fill="url(#g)"/></svg>',
      )
    );
    expect(result.log).not.toMatch(/ERROR/);
    expect(figures(result.html)[0]).toMatch(/<linearGradient id="?dg1-checkout-n4-0-g"?><stop offset="?0"? stop-color="?red"?\/><\/linearGradient>/);
  });

  test('a project icon is rebuilt from its parsed shapes, comments and prolog dropped', () => {
    const exported = '<?xml version="1.0"?>\n<!-- exported -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">'
      + '<title>W &amp; x &#60;b&#62;</title><rect   x=\'1\'  y="1"\n width="6" height="6" rx="1" /></svg>\n';
    const result = build((s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), exported), false);
    expect(result.log).not.toMatch(/ERROR/);
    const icons = [...figures(result.html)[0].matchAll(/<g class="dg-icon dg-icon-stroke"[^>]*>(.*?)<\/g>/g)].map((m) => m[1]);
    const icon = icons.find((body) => body.includes('<rect')) ?? '';
    expect(icon).toContain('<rect x="1" y="1" width="6" height="6" rx="1"/>');
    // Unminified, so the module's own output is what is read: text is decoded and re-escaped,
    // never copied, and a numeric entity comes out named.
    expect(icon).toContain('<title>W &amp; x &lt;b&gt;</title>');
    expect(icon).not.toContain('exported');
  });

  // The figure's own padding and border take width from the column. A canvas just
  // inside the old column-only arithmetic must still fail once that is counted.
  test('the readability floor counts the figure frame, not just the column', () => {
    const width = Number(figures(good.html)[0].match(/--dg-w:([0-9.]+)px/)?.[1]);
    expect(width).toBeGreaterThan(0);
    const column = Math.round((width * 8) / 11) + 20;
    expect((11 * column) / width).toBeGreaterThan(8);
    const result = build((s) => edit(s, 'hugo.yaml', 'content_width: 640', `content_width: ${column}`));
    expect(result.ok).toBe(false);
    expect(result.log).toMatch(/diagram "checkout": smallest label shows at/);
  });

  test('a group with explicit geometry at column 0 builds', () => {
    const result = build((s) =>
      edit(s, 'data/diagrams/checkout.yaml', '- { id: cluster, label: Cluster }', '- { id: cluster, label: Cluster }\n  - { id: zone, label: Zone, col: 0, row: 0, w: 60, h: 30 }')
    );
    expect(result.log).not.toMatch(/ERROR/);
    expect(result.ok).toBe(true);
  });

  // Browsers show an element's nearest <title> as its tooltip; without one per node, every box
  // showed the figure's title.
  test('each node carries its own tooltip: its label, and its description when set', () => {
    const checkout = figures(good.html)[0];
    expect(checkout.match(/<title[^>]*>[^<]*<\/title>/)?.[0]).toMatch(/>Checkout</);
    expect(checkout).toMatch(/data-id="?browser"?[^>]*><title>Browser<\/title>/);
    expect(checkout).toMatch(/data-id="?api"?[^>]*><title>API: Validates the order and returns at once.<\/title>/);
  });

  test('groups carry their own tooltip too', () => {
    expect(figures(good.html)[0]).toMatch(/data-id="?cluster"?[^>]*><title>Cluster<\/title>/);
  });

  test('a label or description is text inside its title, never markup', () => {
    const result = build((s) => {
      edit(s, 'data/diagrams/checkout.yaml', 'label: Browser,', 'label: "</title><script>alert(1)</script>",');
      edit(s, 'data/diagrams/checkout.yaml', 'description: Validates the order and returns at once.,', 'description: "<img src=x onerror=alert(1)> & done",');
    });
    expect(result.log).not.toMatch(/ERROR/);
    const checkout = figures(result.html)[0];
    expect(checkout).not.toMatch(/<script|<img/i);
    expect(checkout).toMatch(/<title>&lt;\/title&gt;&lt;script&gt;/);
    expect(checkout).toMatch(/<title>API: &lt;img src=x onerror=alert\(1\)&gt; &amp; done<\/title>/);
  });

  // Entity text in a label is shown as written, not decoded: the title escapes '&' too.
  test('entity text in a node or group title stays literal', () => {
    const result = build((s) => {
      edit(s, 'data/diagrams/checkout.yaml', 'label: Browser,', 'label: "R&amp;D",');
      edit(s, 'data/diagrams/checkout.yaml', '{ id: cluster, label: Cluster }', '{ id: cluster, label: "R&amp;D", description: "a &lt; b" }');
    });
    expect(result.log).not.toMatch(/ERROR/);
    const checkout = figures(result.html)[0];
    expect(checkout).toMatch(/data-id="?browser"?[^>]*><title>R&amp;amp;D<\/title>/);
    expect(checkout).toMatch(/data-id="?cluster"?[^>]*><title>R&amp;amp;D: a &amp;lt; b<\/title>/);
  });

  test('a viewBox written with commas or extra spaces draws exactly like the plain one', () => {
    const icon = (view: string) => `<svg viewBox="${view}"><rect width="8" height="8"/></svg>`;
    const transform = (view: string) => {
      const result = build((s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), icon(view)));
      expect(result.log).not.toMatch(/ERROR/);
      return figures(result.html)[0].match(/data-id="?worker"?[\s\S]*?<g class="?dg-icon[^>]*transform="?([^">]+)/)?.[1];
    };
    const plain = transform('0 0 8 8');
    expect(plain).toBeTruthy();
    expect(transform('0,0,8,8')).toBe(plain);
    expect(transform(' 0  0 8   8 ')).toBe(plain);
  });

  test('an unknown icon fails with its own error and nothing after it', () => {
    const result = build((s) => edit(s, 'data/diagrams/checkout.yaml', 'icon: inbox', 'icon: no-such-icon'));
    expect(result.ok).toBe(false);
    expect(result.log.match(/no-such-icon/g)?.length).toBe(1);
    expect(result.log).not.toMatch(/divide/);
  });

  test('a logo with internal ids drawn twice on a page repeats no id', () => {
    const result = build((s) => {
      edit(s, 'data/diagrams/checkout.yaml', 'icon: logos/cloudflare-icon', 'icon: logos/aws-ec2');
      edit(s, 'data/diagrams/checkout.yaml', 'icon: logos/postgresql', 'icon: logos/aws-ec2');
    });
    expect(result.log).not.toMatch(/ERROR/);
    const all = ids(result.html);
    expect(new Set(all).size).toBe(all.length);
    for (const [, ref] of result.html.matchAll(/url\(#([^)]+)\)/g)) expect(all).toContain(ref);
    expect(result.html).not.toContain('__DGI__');
  });

  test('a bare diagram name attributes the page like a quoted one', () => {
    const result = build((s) => edit(s, 'content/_index.md', '{{< diagram "refund" >}}', '{{< diagram refund >}}'));
    expect(result.log).not.toMatch(/ERROR/);
    const json = JSON.parse(readFileSync(join(result.site, 'public', 'architecture.json'), 'utf8'));
    expect(json.diagrams.find((d: { name: string }) => d.name === 'refund').pages).toEqual(['https://example.org/']);
  });

  test('a bare name does not attribute a spec whose name it starts with', () => {
    const result = build((s) => {
      writeFileSync(join(s, 'data/diagrams/refund-v2.yaml'), readFileSync(join(s, 'data/diagrams/refund.yaml'), 'utf8'));
      edit(s, 'content/_index.md', '{{< diagram "refund" >}}', '{{< diagram refund-v2 >}}');
    });
    expect(result.log).not.toMatch(/ERROR/);
    const json = JSON.parse(readFileSync(join(result.site, 'public', 'architecture.json'), 'utf8'));
    const pages = (name: string) => json.diagrams.find((d: { name: string }) => d.name === name).pages;
    expect(pages('refund-v2')).toEqual(['https://example.org/']);
    expect(pages('refund')).toEqual([]);
  });

  test('a page is attributed however the shortcode is spaced', () => {
    const result = build((s) => edit(s, 'content/_index.md', '{{< diagram "refund" >}}', '{{<   diagram   "refund"   >}}'));
    const json = JSON.parse(readFileSync(join(result.site, 'public', 'architecture.json'), 'utf8'));
    expect(json.diagrams.find((d: { name: string }) => d.name === 'refund').pages).toEqual(['https://example.org/']);
  });

  test('the same diagram twice on a page gets two figure ids', () => {
    const result = build((s) => edit(s, 'content/_index.md', '{{< diagram "refund" >}}', '{{< diagram "refund" >}}\n\n{{< diagram "refund" >}}'));
    const ids = [...result.html.matchAll(/<figure class="?dg"? id="?([^" >]+)/g)].map((m) => m[1]);
    expect(ids).toEqual(['diagram-checkout', 'diagram-refund', 'diagram-refund-2']);
  });

  test('the shipped check script passes a site that publishes no llms.txt', () => {
    // The script runs node from a temp site outside the repo, where a version
    // manager's shim finds no pin and may fail or pick another node. Hand it the
    // binary that resolves here, under the repo's pin.
    const node = Bun.spawnSync(['node', '-p', 'process.execPath'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    if (node.exitCode !== 0) throw new Error(`node does not resolve in the repo: ${node.stderr}`);
    const nodeDir = dirname(`${node.stdout}`.trim());
    const run = Bun.spawnSync(['sh', join(MODULE_PARENT, 'diagrams', 'scripts', 'check-diagrams.sh'), good.site], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${dirname(HUGO as string)}:${nodeDir}:${process.env.PATH}` },
    });
    expect(`${run.stdout}${run.stderr}`).toContain('ok: 2 diagrams, no mermaid');
    expect(run.exitCode).toBe(0);
  });
});

describe('logo ids get the per-instance placeholder', () => {
  test('every way of writing a reference is rewritten with its id', () => {
    const out = placeholderIds(
      [
        '<linearGradient id="g"/><linearGradient id="gb"/>',
        '<path fill="url(#g)"/>',
        "<path fill=\"url('#g')\"/>",
        '<path style="fill:url(&quot;#g&quot;)"/>',
        '<path fill="url(&apos;#gb&apos;)"/>',
        '<path fill="url( #gb )"/>',
        '<use href="#g"/>',
        '<use href=" #gb"/>',
        "<use xlink:href='#gb'/>",
      ].join(''),
    );
    for (const expected of [
      'id="__DGI__g"',
      'id="__DGI__gb"',
      'url(#__DGI__g)',
      "url('#__DGI__g')",
      'url(&quot;#__DGI__g&quot;)',
      'url(&apos;#__DGI__gb&apos;)',
      'url(#__DGI__gb)',
      'href="#__DGI__g"',
      'href="#__DGI__gb"',
      "href='#__DGI__gb'",
    ]) {
      expect(out).toContain(expected);
    }
    expect(out).not.toMatch(/#(?!__DGI__)gb?\b/);
  });

  test('a reference to an id the icon never defines fails instead of dangling', () => {
    expect(() => placeholderIds('<path fill="url(#missing)"/>')).toThrow(/url\(#missing/);
    expect(() => placeholderIds('<path fill="url( &quot;#missing&quot; )"/>')).toThrow(/missing/);
    expect(() => placeholderIds("<use href='#missing'/>")).toThrow(/missing/);
    expect(() => placeholderIds('<path fill="url(&apos;#missing&apos;)"/>')).toThrow(/missing/);
    expect(() => placeholderIds('<use href=" #missing"/>')).toThrow(/missing/);
  });

  // Unlisted quoting is caught by what it leaves behind, not by naming every form.
  test('a reference in a form the rewrite does not know still fails', () => {
    expect(() => placeholderIds('<linearGradient id="g"/><path fill="url(&#39;#g&#39;)"/>')).toThrow(/#g kept its bare id/);
    expect(() => placeholderIds('<linearGradient id="g"/><path fill="url(&#34;#g&#34;)"/>')).toThrow(/#g kept its bare id/);
  });
});

describe('the module keeps its own numbers in step', () => {
  test('the readability frame matches the figure padding and border in the stylesheet', () => {
    const css = readFileSync(join(MODULE_PARENT, 'diagrams', 'assets', 'css', 'diagram.css'), 'utf8');
    const check = readFileSync(join(MODULE_PARENT, 'diagrams', 'layouts', '_partials', 'diagram', 'readable.html'), 'utf8');
    const figure = css.match(/figure\.dg \{([^}]*)\}/)?.[1] ?? '';
    const side = Number(figure.match(/padding: [0-9.]+rem ([0-9.]+)rem/)?.[1]);
    const border = Number(figure.match(/border: (\d+)px/)?.[1]);
    expect(Number(check.match(/\$chrome := ([0-9.]+)/)?.[1])).toBeCloseTo(2 * side * 16 + 2 * border, 5);
  });

  test('the readability floor reads the same label size the stylesheet sets', () => {
    const css = readFileSync(join(MODULE_PARENT, 'diagrams', 'assets', 'css', 'diagram.css'), 'utf8');
    const check = readFileSync(join(MODULE_PARENT, 'diagrams', 'layouts', '_partials', 'diagram', 'readable.html'), 'utf8');
    const mono = css.match(/\.dg-ts, \.dg-ta, \.dg-tg, \.dg-td, \.dg-tl \{[^}]*font-size: (\d+)px/)?.[1];
    const smallest = check.match(/\$smallest := (\d+)\.0/)?.[1];
    expect(mono).toBeDefined();
    expect(smallest).toBe(mono);
  });

  test('the vendored brand icons match the diagram skill\'s CC0 packs', () => {
    const run = Bun.spawnSync(['bun', join(ROOT, 'scripts/sync-hugo-diagram-icons.ts'), '--check'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
  });
});

// Real exports from design tools, as a reviewer collected them. Each must build
// to clean markup; the three that need a tool pass first must say how.
const ICONS = join(import.meta.dir, 'fixtures', 'icons');
// Where an export carried its paint in style or on the root, the rebuilt icon must still paint.
const PAINTED: Record<string, RegExp[]> = {
  'inkscape.svg': [/fill="none"/, /stroke="#000(000)?"/, /stroke-width="2"/],
  'inkscape-plain.svg': [/fill="none"/, /stroke="#000(000)?"/],
  'figma-mask.svg': [/mask-type="alpha"/],
  'lucide.svg': [/^<g fill="none" stroke="currentColor" stroke-width="2"/],
  // A chained gradient is resolved at build time: each link carries its own copy of the stops.
  'inkscape-gradient.svg': [
    /<linearGradient id="dg1-checkout-n4-0-h"(?=[^>]*x2="16")(?=[^>]*gradientUnits="userSpaceOnUse")[^>]*>(<stop[^>]*\/>){2}<\/linearGradient>/,
    /^(?![\s\S]*href)/,
  ],
  // Prefixes resolve by namespace: d: is bound to SVG and kept; svg: here is bound elsewhere and dropped.
  'svg-prefixed.svg': [/<rect width="8" height="8" fill="(red|#f00)"/, /^(?![\s\S]*width="4")/],
};
const REFUSED: Record<string, RegExp> = {
  'illustrator.svg': /<style>/,
  'title-class.svg': /attribute class/,
  'use.svg': /<use>/,
};

describe('icons exported by design tools', () => {
  for (const file of readdirSync(ICONS).filter((f) => f.endsWith('.svg')).sort()) {
    test(file, () => {
      const result = build((s) => cpSync(join(ICONS, file), join(s, 'assets/icons/acme/widget.svg')));
      if (REFUSED[file]) {
        expect(result.ok).toBe(false);
        expect(result.log).toMatch(REFUSED[file]);
        expect(result.log).toContain('Preparing icons');
        return;
      }
      expect(result.log).not.toMatch(/ERROR|WARN/);
      const icon = figures(result.html)[0].match(/data-id="?worker"?[\s\S]*?<g class="dg-icon[^>]*>([\s\S]*?)<\/g><text/)?.[1] ?? '';
      expect(icon).toMatch(/<(path|circle|rect)/);
      // Nothing an editor wrote reaches the page.
      expect(icon).not.toMatch(/style=|class=|sodipodi|inkscape|xmlns|\ufeff/);
      for (const paint of PAINTED[file] ?? []) expect(icon).toMatch(paint);
    });
  }

  test('icons from packs whose names used to collide keep separate ids', () => {
    const result = build((s) => {
      for (const [dir, name] of [['ab', 'c'], ['a', 'b-c'], ['up', 'Icon'], ['up', 'icon']]) {
        mkdirSync(join(s, 'assets/icons', dir), { recursive: true });
        writeFileSync(join(s, 'assets/icons', dir, `${name}.svg`), readFileSync(join(ICONS, 'gradient.svg'), 'utf8'));
      }
      edit(s, 'hugo.yaml', '    icons:\n', '    icons:\n      a-b: {path: icons/ab}\n      a: {path: icons/a}\n      up: {path: icons/up}\n');
      edit(s, 'data/diagrams/checkout.yaml', 'icon: user', 'icon: "@a-b/c"');
      edit(s, 'data/diagrams/checkout.yaml', 'icon: inbox', 'icon: "@a/b-c"');
      edit(s, 'data/diagrams/checkout.yaml', 'icon: logos/cloudflare-icon', 'icon: "@up/Icon"');
      edit(s, 'data/diagrams/checkout.yaml', 'icon: logos/postgresql', 'icon: "@up/icon"');
    });
    expect(result.log).not.toMatch(/ERROR/);
    const all = [...result.html.matchAll(/\sid="?([^"\s>]+)/g)].map((m) => m[1]);
    expect(all.filter((id) => id.endsWith('-0-g'))).toHaveLength(4);
    expect(new Set(all).size).toBe(all.length);
  });
});

const chrome = chromePath();
if (!chrome) {
  console.error(
    'SKIPPED the enlarge cases in tests/diagram/hugo/module.test.ts: no Chrome/Chromium found, so '
      + 'nothing here checked the enlarged view. Set AGENTKIT_CHROMIUM to a browser binary.',
  );
}

async function page(run: (session: Session) => Promise<void>, site: Build = good) {
  const root = join(site.site, 'public');
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const file = Bun.file(join(root, path.endsWith('/') ? `${path}index.html` : path));
      return file.size ? new Response(file) : new Response('not found', { status: 404 });
    },
  });
  const launch = await launchBrowser({ binary: chrome as string });
  let session: Session | undefined;
  try {
    session = await attach(launch.endpoint);
    await Promise.all([session.send('Runtime.enable'), session.send('Page.enable')]);
    await session.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/` });
    const deadline = Date.now() + 30_000;
    while (!(await evaluate(session, `!!document.querySelector('.dg-enlarge')`))) {
      if (Date.now() > deadline) throw new Error(`diagram.js never ran: ${session.logs.join('\n') || 'no logs'}`);
      await Bun.sleep(100);
    }
    await run(session);
  } finally {
    session?.close();
    await launch.close();
    server.stop(true);
  }
}

describe.if(chrome !== null)('a gradient that inherits its stops', () => {
  // Pixels, not markup: the chain s <- g <- h must paint red into blue across the icon.
  test('paints red on the left and blue on the right in a real browser', async () => {
    const site = build((s) => {
      cpSync(join(ICONS, 'inkscape-gradient.svg'), join(s, 'assets/icons/acme/widget.svg'));
      edit(s, 'hugo.yaml', 'mode: stroke', 'mode: color');
    });
    expect(site.ok).toBe(true);
    await page(async (s) => {
      await evaluate(
        s,
        `(() => { const icon = document.querySelector('.dg-node[data-id="worker"] .dg-icon');
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">'
            + icon.innerHTML + '</svg>';
          const img = new Image();
          img.onload = () => { const c = document.createElement('canvas'); c.width = 16; c.height = 16;
            const x = c.getContext('2d'); x.drawImage(img, 0, 0);
            window.__px = [2, 13].map((px) => [...x.getImageData(px, 8, 1, 1).data].slice(0, 3)); };
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); })()`,
      );
      let px: number[][] | undefined;
      for (let i = 0; i < 50 && !px; i++) {
        px = (await evaluate(s, 'window.__px')) as number[][] | undefined;
        if (!px) await Bun.sleep(100);
      }
      expect(px).toBeDefined();
      const [left, right] = px as number[][];
      expect(left[0]).toBeGreaterThan(180);
      expect(left[2]).toBeLessThan(80);
      expect(right[2]).toBeGreaterThan(180);
      expect(right[0]).toBeLessThan(80);
    }, site).catch((e: unknown) => rethrowLaunchFailure(e, 'the chained gradient pixel assertions'));
  }, 120_000);
});

describe.if(chrome !== null)('root presentation attributes in colour mode', () => {
  for (const [file, expected] of [
    ['lucide.svg', { fill: 'none', strokeIsInk: true }],
    ['figma-ring.svg', { fill: 'none', stroke: 'rgb(17, 24, 39)' }],
  ] as const) {
    test(`${file} draws with the root's fill and stroke`, async () => {
      const site = build((s) => {
        cpSync(join(ICONS, file), join(s, 'assets/icons/acme/widget.svg'));
        edit(s, 'hugo.yaml', 'mode: stroke', 'mode: color');
      });
      expect(site.ok).toBe(true);
      await page(async (s) => {
        const style = JSON.parse(
          (await evaluate(
            s,
            `(() => { const el = document.querySelector('.dg-node[data-id="worker"] .dg-icon :is(path, circle)');
              const cs = getComputedStyle(el); const ink = getComputedStyle(document.querySelector('.dg-svg')).color;
              return JSON.stringify({ fill: cs.fill, stroke: cs.stroke, ink }); })()`,
          )) as string,
        );
        expect(style.fill).toBe(expected.fill);
        if ('stroke' in expected) expect(style.stroke).toBe(expected.stroke);
        if ('strokeIsInk' in expected) expect(style.stroke).toBe(style.ink);
      }, site).catch((e: unknown) => rethrowLaunchFailure(e, `the ${file} render assertions`));
    }, 120_000);
  }
});

describe.if(chrome !== null)('the enlarged view in a real browser', () => {
  test('opens at 1:1, keeps the page figure intact, closes back to its button', async () => {
    await page(async (s) => {
      const opened = await evaluate(
        s,
        `(() => {
          const fig = document.querySelector('figure.dg');
          fig.querySelector('.dg-enlarge').click();
          const dlg = document.querySelector('dialog.dg-zoom');
          const copy = dlg.querySelector('.dg-svg');
          return JSON.stringify({
            open: dlg.open,
            width: copy.getBoundingClientRect().width,
            native: copy.viewBox.baseVal.width,
            ids: [...copy.querySelectorAll('[id]')].every((e) => e.id.endsWith('-z')),
            marker: copy.querySelector('[marker-end]').getAttribute('marker-end'),
            dangling: [...copy.querySelectorAll('*')].flatMap((e) => [...e.attributes])
              .flatMap((a) => [...a.value.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]))
              .filter((id) => !copy.querySelector('[id="' + id + '"]')),
            colours: [...copy.querySelectorAll('[fill^="#"], [stop-color^="#"]')]
              .map((e) => e.getAttribute('fill') ?? e.getAttribute('stop-color')),
            describedTitle: !!document.querySelector('figure.dg .dg-node[data-id="api"] > title'),
            plainTitle: document.querySelector('figure.dg .dg-node[data-id="browser"] > title')?.textContent,
            pageFigures: document.querySelectorAll('figure.dg .dg-svg').length,
            focus: document.activeElement.className,
          });
        })()`,
      );
      const o = JSON.parse(opened as string);
      expect(o.open).toBe(true);
      expect(Math.abs(o.width - o.native)).toBeLessThan(1);
      expect(o.ids).toBe(true);
      expect(o.marker).toMatch(/-z\)$/);
      expect(o.dangling).toEqual([]);
      // Hex colours look like references; the rewrite must leave them alone.
      expect(o.colours.length).toBeGreaterThan(0);
      for (const c of o.colours) expect(c).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      // A node with a description shows the script's tip, so its native title is gone; one
      // without keeps its name as the tooltip.
      expect(o.describedTitle).toBe(false);
      expect(o.plainTitle).toBe('Browser');
      expect(o.pageFigures).toBe(2);
      expect(o.focus).toBe('dg-zoom-close');
      await evaluate(s, `document.querySelector('.dg-zoom-close').click()`);
      // A dialog's close event is queued; wait for it rather than for a fixed time.
      for (let t = 0; t < 50 && (await evaluate(s, `!!document.querySelector('dialog.dg-zoom')`)); t++) {
        await Bun.sleep(50);
      }
      const closed = await evaluate(
        s,
        `JSON.stringify({ gone: !document.querySelector('dialog.dg-zoom'), focus: document.activeElement.className })`,
      );
      expect(JSON.parse(closed as string)).toEqual({ gone: true, focus: 'dg-enlarge' });
    }).catch((e: unknown) => rethrowLaunchFailure(e, 'the enlarge-and-close assertions'));
  }, 120_000);

  test('a click on the backdrop closes it; a click on a node highlights instead of opening', async () => {
    await page(async (s) => {
      const result = await evaluate(
        s,
        `(() => {
          const svg = document.querySelector('figure.dg .dg-svg');
          svg.querySelector('.dg-node[data-id="api"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
          const hot = [...svg.querySelectorAll('.dg-edge.is-hot')].length;
          const openedByNode = !!document.querySelector('dialog.dg-zoom');
          svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          const dlg = document.querySelector('dialog.dg-zoom');
          const openedByCanvas = !!dlg && dlg.open;
          dlg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return JSON.stringify({ hot, openedByNode, openedByCanvas });
        })()`,
      );
      expect(JSON.parse(result as string)).toEqual({ hot: 3, openedByNode: false, openedByCanvas: true });
      await Bun.sleep(200);
      expect(await evaluate(s, `!document.querySelector('dialog.dg-zoom')`)).toBe(true);
    }).catch((e: unknown) => rethrowLaunchFailure(e, 'the backdrop and node-click assertions'));
  }, 120_000);
});
