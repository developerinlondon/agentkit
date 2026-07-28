import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledThemePath, mermaidRuntime, renderThemed } from '../../skills/publish-page/render-html.ts';

// A diagram's source is author text, and in a product brief it is crawled text:
// the fence reaches mermaid's parser verbatim by design. What mermaid then does
// with a hostile label is configuration, so the configuration is asserted here
// rather than inherited from a release default.
const HOSTILE = `<pre class="mermaid">flowchart LR
  A[&quot;&lt;script&gt;mm&lt;/script&gt;&quot;] --&gt; B[two]
  click A href &quot;javascript:alert(1)&quot;</pre>`;

function chromePath(): string | null {
  const candidates = [
    process.env.AGENTKIT_CHROMIUM,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c)) ?? null;
}

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
});

// The rendered DOM, not the source: mermaid builds these nodes at runtime, so
// only a browser can say what the reader is actually served.
describe.if(chrome !== null)('a hostile diagram in a real browser', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agentkit-mermaid-'));

  async function renderedDiagram(level: 'strict' | 'loose'): Promise<string> {
    const page = await renderThemed({
      source: HOSTILE,
      isMd: false,
      template: 'doc',
      title: 'diagram',
      themePath: bundledThemePath('doc'),
    });
    const file = join(scratch, `${level}.html`);
    writeFileSync(file, level === 'strict' ? page : page.replace('securityLevel: "strict"', 'securityLevel: "loose"'));
    const dumped = Bun.spawnSync([
      chrome as string,
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--virtual-time-budget=20000',
      '--dump-dom',
      `file://${file}`,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const dom = dumped.stdout.toString();
    const drawn = dom.match(/<pre class="mermaid"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? '';
    // An empty match would let every assertion below pass without a diagram.
    expect(drawn, `${level}: no mermaid block in the dumped DOM`).toContain('<svg');
    expect(drawn, `${level}: mermaid could not parse the fixture`).not.toContain('Syntax error');
    return drawn;
  }

  test('the label sanitiser runs: no script, no event handler', async () => {
    const drawn = await renderedDiagram('strict');
    expect(drawn).not.toContain('<script');
    expect(drawn).not.toMatch(/\son[a-z]+\s*=/);
  });

  // Positive control in the same run: the identical probe over a page whose
  // only difference is the setting must find the live handler, or the case
  // above is asserting nothing about the setting it exists to pin.
  test('a script-scheme click is dropped, and would not be under loose', async () => {
    expect(await renderedDiagram('strict')).not.toContain('javascript:alert(1)');
    expect(await renderedDiagram('loose')).toContain('xlink:href="javascript:alert(1)"');
  });

  afterAll(() => rmSync(scratch, { force: true, recursive: true }));
});
