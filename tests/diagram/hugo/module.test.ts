import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromePath, launchBrowser, rethrowLaunchFailure } from '../../publish-page/browser-launch.ts';
import { attach, evaluate, type Session } from '../../publish-page/devtools.ts';

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
  throw new Error('tests/diagram/hugo/module.test.ts needs Hugo >= 0.146 on PATH (or HUGO_BIN); CI installs it');
}

interface Build {
  ok: boolean;
  log: string;
  site: string;
  html: string;
}

let counter = 0;

// Each build gets its own copy so a mutation in one case cannot leak into another.
function build(mutate?: (site: string) => void): Build {
  const site = join(scratch, `site-${++counter}`);
  cpSync(EXAMPLE, site, { recursive: true });
  // The example points at the module relative to itself; a copy has to name it.
  edit(site, 'hugo.yaml', 'themesDir: ../..', `themesDir: ${MODULE_PARENT}`);
  mutate?.(site);
  const run = Bun.spawnSync(
    [HUGO as string, '--minify', '-s', site, '-d', join(site, 'public')],
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
      'a project icon file that is missing',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '"@acme/widget"', '"@acme/gadget"'),
      /icon "@acme\/gadget": assets\/icons\/acme\/gadget.svg does not exist/,
    ],
    [
      'a project icon that nests an <svg>',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><svg><rect/></svg></svg>'),
      /contains a nested or stray <svg>/,
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
      'a label pinned to a segment the route does not have',
      (s) => edit(s, 'data/diagrams/checkout.yaml', '{ from: queue, to: worker }', '{ from: queue, to: worker, label: x, label_segment: 4 }'),
      /edge queue → worker: label_segment 4, but the route has 1 segments/,
    ],
    [
      'a project icon that carries a script',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><script>alert(1)</script></svg>'),
      /project icons may hold shapes only/,
    ],
    [
      'a project icon that carries a stylesheet',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><style>body{display:none}</style><rect/></svg>'),
      /contains "<style>"/,
    ],
    [
      'a project icon with an event handler',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect onload="x()"/></svg>'),
      /project icons may hold shapes only/,
    ],
    [
      'a project icon with content after its closing tag',
      (s) => writeFileSync(join(s, 'assets/icons/acme/widget.svg'), '<svg viewBox="0 0 8 8"><rect/></svg>\n<!-- exported -->\n'),
      /has content after its closing <\/svg>/,
    ],
    [
      'a font token with an unbalanced quote',
      (s) => edit(s, 'hugo.yaml', 'radius: 6', `radius: 6\n      sans: '"Inter'`),
      /tokens.sans: .* is not a font-family list/,
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
    const run = Bun.spawnSync(['sh', join(MODULE_PARENT, 'diagrams', 'scripts', 'check-diagrams.sh'), good.site], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${dirname(HUGO as string)}:${process.env.PATH}` },
    });
    expect(`${run.stdout}${run.stderr}`).toContain('ok: 2 diagrams, no mermaid');
    expect(run.exitCode).toBe(0);
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

const chrome = chromePath();
if (!chrome) {
  console.error(
    'SKIPPED the enlarge cases in tests/diagram/hugo/module.test.ts: no Chrome/Chromium found, so '
      + 'nothing here checked the enlarged view. Set AGENTKIT_CHROMIUM to a browser binary.',
  );
}

async function page(run: (session: Session) => Promise<void>) {
  const root = join(good.site, 'public');
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
      expect(o.pageFigures).toBe(2);
      expect(o.focus).toBe('dg-zoom-close');
      await evaluate(s, `document.querySelector('.dg-zoom-close').click()`);
      // A dialog's close event is queued, so the state is read after it has run.
      await Bun.sleep(200);
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
