import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledThemePath, mermaidRuntime, renderThemed } from '../../skills/publish-page/render-html.ts';
import { chromePath, launchBrowser, rethrowLaunchFailure } from './browser-launch.ts';
import { attach, evaluate, type Session } from './devtools.ts';

// A diagram's source is author text, and in a product brief it is crawled text:
// the fence reaches mermaid's parser verbatim by design. What mermaid then does
// with a hostile label is configuration, so the configuration is asserted here
// rather than inherited from a release default.
const HOSTILE = `<pre class="mermaid">flowchart LR
  A[&quot;&lt;script&gt;mm&lt;/script&gt;&quot;] --&gt; B[two]
  click A href &quot;javascript:alert(1)&quot;</pre>`;

// mermaid draws after load and takes as long as the machine takes, so the wait
// is for the diagram to exist — not for a duration. A 2-core CI runner spent
// longer than any interval that looked generous on a developer machine.
const RENDER_BUDGET_MS = 45_000;
// Two renders in the widest case, each able to spend two 20s launch attempts
// before its 45s render budget. Below 170_000 the harness's own timeout fires
// first and replaces the launcher's stderr report with a bare "timed out".
const CASE_TIMEOUT_MS = 180_000;

const chrome = chromePath();
if (!chrome) {
  console.error(
    'SKIPPED tests/publish-page/mermaid-runtime.test.ts: no Chrome/Chromium found — the '
      + 'hostile-diagram cases did NOT run, so nothing here checked what mermaid renders. '
      + 'Set AGENTKIT_CHROMIUM to a browser binary.',
  );
}

describe('mermaid runtime configuration', () => {
  test('the inlined runtime pins securityLevel instead of taking the default', async () => {
    expect(await mermaidRuntime()).toContain('securityLevel: "strict"');
  });

  // Measured, not assumed: with startOnLoad left at its default, mermaid draws
  // the page's diagrams itself on DOMContentLoaded — under ITS defaults, not
  // the configuration above. Our init must be the thing that renders.
  test('the runtime renders under our configuration, not mermaid autostart', async () => {
    expect(await mermaidRuntime()).toContain('startOnLoad: false');
  });
});

// Everything the reader would see, once there is something to see. throttle
// slows the renderer the way a loaded CI runner does, so the waiting itself is
// exercised rather than assumed.
async function renderedPage(html: string, throttle = 1): Promise<string> {
  const launch = await launchBrowser({ binary: chrome as string });
  const file = join(launch.profile, 'page.html');
  writeFileSync(file, html);
  let session: Session | undefined;
  try {
    session = await attach(launch.endpoint);
    await Promise.all([session.send('Runtime.enable'), session.send('Log.enable'), session.send('Page.enable')]);
    if (throttle > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await session.send('Page.navigate', { url: `file://${file}` });
    const deadline = Date.now() + RENDER_BUDGET_MS;
    while (Date.now() < deadline) {
      if (await evaluate(session, `!!document.querySelector('pre.mermaid svg')`)) {
        return await evaluate(session, 'document.documentElement.outerHTML') as string;
      }
      await Bun.sleep(100);
    }
    const state = await evaluate(
      session,
      `JSON.stringify({ readyState: document.readyState, mermaid: typeof globalThis.mermaid,`
        + ` blocks: document.querySelectorAll('pre.mermaid').length,`
        + ` text: (document.querySelector('pre.mermaid') || {}).textContent })`,
    );
    throw new Error(
      `no diagram after ${RENDER_BUDGET_MS}ms (throttle ${throttle}x)\npage: ${state}\nerrors: ${
        session.logs.join('\n') || 'none'
      }\nbrowser stderr: ${launch.stderrTail() || 'none'}`,
    );
  } finally {
    session?.close();
    await launch.close();
  }
}

// The rendered DOM, not the source: mermaid builds these nodes at runtime, so
// only a browser can say what the reader is actually served.
describe.if(chrome !== null)('a hostile diagram in a real browser', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agentkit-mermaid-'));

  async function themed(level: 'strict' | 'loose'): Promise<string> {
    const page = await renderThemed({
      source: HOSTILE,
      isMd: false,
      template: 'doc',
      title: 'diagram',
      themePath: bundledThemePath('doc'),
    });
    return level === 'strict' ? page : page.replace('securityLevel: "strict"', 'securityLevel: "loose"');
  }

  async function diagram(level: 'strict' | 'loose', throttle = 1): Promise<string> {
    const dom = await renderedPage(await themed(level), throttle).catch((error: unknown) =>
      rethrowLaunchFailure(error, `${level}: the sanitiser assertions`)
    );
    const drawn = dom.match(/<pre class="mermaid"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? '';
    // An empty match would let every assertion below pass without a diagram.
    expect(drawn, `${level}: no mermaid block in the rendered DOM`).toContain('<svg');
    expect(drawn, `${level}: mermaid could not parse the fixture`).not.toContain('Syntax error');
    return drawn;
  }

  test('the label sanitiser runs: no script, no event handler', async () => {
    const drawn = await diagram('strict');
    expect(drawn).not.toContain('<script');
    expect(drawn).not.toMatch(/\son[a-z]+\s*=/);
  }, CASE_TIMEOUT_MS);

  // Positive control in the same run: the identical probe over a page whose
  // only difference is the setting must find the live handler, or the case
  // above is asserting nothing about the setting it exists to pin.
  test('a script-scheme click is dropped, and would not be under loose', async () => {
    expect(await diagram('strict')).not.toContain('javascript:alert(1)');
    expect(await diagram('loose')).toContain('xlink:href="javascript:alert(1)"');
  }, CASE_TIMEOUT_MS);

  // The waiting is the thing under test here: throttled hard enough that the
  // diagram cannot be there on the first look, the same assertions must still
  // hold. A fixed wait passes this only by being longer than the machine is
  // slow, which is the bet that failed on CI.
  test('a browser far slower than this one is waited for, not raced', async () => {
    const drawn = await diagram('strict', 20);
    expect(drawn).not.toContain('<script');
  }, CASE_TIMEOUT_MS);

  afterAll(() => rmSync(scratch, { force: true, recursive: true }));
});
