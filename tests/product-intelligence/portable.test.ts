import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderBriefHtml } from '../../skills/product-intelligence/scripts/html.ts';

const repoRoot = dirname(dirname(import.meta.dir));
const skillRoot = join(repoRoot, 'skills', 'product-intelligence');
const publishSkill = join(repoRoot, 'skills', 'publish-page');
const mixed = join(skillRoot, 'examples', 'mixed');

let scratch = '';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'agentkit-portable-'));
});
afterEach(() => {
  rmSync(scratch, { force: true, recursive: true });
});

function copyOfMixed(name: string): string {
  const dir = join(scratch, name);
  cpSync(mixed, dir, { recursive: true });
  return dir;
}

// A standalone copy of the two skills, laid out as they sit in the repo. It
// lets a test decide whether the dependencies are there and mark its own
// bundled theme, neither of which can be done to the repo's own tree while
// other work shares it.
function skillTree(name: string, options: { deps: boolean; sentinel?: string }): string {
  const root = join(scratch, name);
  const publishCopy = join(root, 'skills', 'publish-page');
  cpSync(publishSkill, publishCopy, {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  });
  cpSync(join(skillRoot, 'scripts'), join(root, 'skills', 'product-intelligence', 'scripts'), {
    recursive: true,
  });
  if (options.deps) {
    symlinkSync(join(publishSkill, 'node_modules'), join(publishCopy, 'node_modules'));
  }
  if (options.sentinel) {
    const theme = join(publishCopy, 'themes', 'doc.html');
    writeFileSync(theme, readFileSync(theme, 'utf-8').replace('</head>', `<!--${options.sentinel}--></head>`));
  }
  return root;
}

function renderCli(root: string, args: string[], env: Record<string, string> = {}) {
  const script = join(root, 'skills', 'product-intelligence', 'scripts', 'render.ts');
  return spawnSync('bun', [script, ...args], { encoding: 'utf-8', env: { ...process.env, ...env } });
}

// Attribute values only. A verbatim quote in the evidence may well contain a
// URL — printing one costs nothing, while an attribute is what actually makes
// the browser reach for the network.
function remoteAttributes(html: string): string[] {
  const hits: string[] = [];
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    const element = tag.match(/^<([a-zA-Z0-9]+)/)![1].toLowerCase();
    for (const [, attr, quoted, bare] of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|([^\s>]+))/g)) {
      const value = quoted ?? bare ?? '';
      if (!/^(?:https?:)?\/\//i.test(value)) continue;
      if (element === 'a' && attr.toLowerCase() === 'href') continue;
      hits.push(`${element}[${attr}]=${value}`);
    }
  }
  return hits;
}

describe('portable brief page', () => {
  test('fetches nothing: no remote attribute, stylesheet, import or script src', async () => {
    const html = await renderBriefHtml(mixed);
    expect(remoteAttributes(html)).toEqual([]);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/\b(?:fetch|importScripts|EventSource|XMLHttpRequest|WebSocket)\s*\(/);
  });

  // Pins the one allowance the check above grants, so a theme that starts
  // linking a CDN cannot hide behind "it is only an anchor".
  test('the only outbound link is the theme footer', async () => {
    const html = await renderBriefHtml(mixed);
    const outbound = [...html.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]*)"/gi)].map((m) => m[1]);
    expect(outbound).toEqual(['https://agentkit.sbs']);
  });

  test('carries the brief, the evidence anchors and the findings', async () => {
    const html = await renderBriefHtml(mixed);
    expect(html).toContain('<title>acme-notes: what the evidence says</title>');
    expect(html).toContain('<strong>For</strong> solo developers');
    expect(html).toContain('<h2>What the analyze pass flagged</h2>');
    const ledger = readFileSync(join(mixed, 'ledger.yaml'), 'utf-8');
    for (const id of new Set(ledger.match(/C-\d{3}/g) ?? [])) {
      expect(html, id).toContain(`id="${id.toLowerCase()}"`);
    }
  });

  test('same inputs render byte-identical output, from any path', async () => {
    const [first, second] = await Promise.all([renderBriefHtml(mixed), renderBriefHtml(mixed)]);
    expect(first).toBe(second);
    // A different directory for the same artifacts: catches a build stamp or a
    // source path leaking into the page.
    const elsewhere = await renderBriefHtml(copyOfMixed('copy'));
    expect(elsewhere).toBe(first);
  });

  test('a hostile subject name cannot escape the title', async () => {
    const dir = copyOfMixed('hostile');
    const brief = readFileSync(join(dir, 'brief.yaml'), 'utf-8')
      .replace('name: acme-notes', 'name: "</title><script>alert(1)</script>"');
    writeFileSync(join(dir, 'brief.yaml'), brief);
    const html = await renderBriefHtml(dir);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  // The page must come from the theme shipped beside the script. publish.ts
  // prefers a canonical clone when one exists, and a portable page that
  // silently followed it would render differently on every machine.
  test('renders the bundled theme, not a canonical clone', async () => {
    const clone = join(scratch, 'pages-clone');
    mkdirSync(join(clone, 'themes'), { recursive: true });
    const bundled = readFileSync(join(publishSkill, 'themes', 'doc.html'), 'utf-8');
    writeFileSync(join(clone, 'themes', 'doc.html'), bundled.replace('</head>', '<!--CLONE-THEME--></head>'));

    const root = skillTree('themed', { deps: true, sentinel: 'BUNDLED-THEME' });
    const out = join(scratch, 'themed.html');
    const result = renderCli(root, [mixed, '--html', '--out', out], { AGENTKIT_PAGES_REPO: clone });

    expect(result.status, result.stderr).toBe(0);
    const html = readFileSync(out, 'utf-8');
    expect(html).toContain('<!--BUNDLED-THEME-->');
    expect(html).not.toContain('<!--CLONE-THEME-->');
  });

  test('the mermaid runtime is inlined only when the page has a diagram', async () => {
    const plain = await renderBriefHtml(mixed);
    expect(plain).not.toContain('class="mermaid"');
    expect(plain).not.toContain('mermaid.initialize');

    const dir = copyOfMixed('diagram');
    writeFileSync(join(dir, 'findings.md'), '# Findings\n\n## Gaps\n\n```mermaid\nflowchart LR\n  a --> b\n```\n');
    const withDiagram = await renderBriefHtml(dir);
    expect(withDiagram).toContain('class="mermaid"');
    expect(withDiagram).toContain('mermaid.initialize');
    expect(withDiagram).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
  });
});

// The CLI surface both Pages scaffolds invoke.
describe('render.ts --html', () => {
  test('writes index.html into the intelligence dir by default', async () => {
    const dir = copyOfMixed('cli-default');
    const result = renderCli(skillTree('cli', { deps: true }), [dir, '--html']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(join(dir, 'index.html'));
    expect(readFileSync(join(dir, 'index.html'), 'utf-8')).toBe(await renderBriefHtml(mixed));
  });

  test('--out writes there, and the flag may lead the directory', () => {
    const root = skillTree('cli-out', { deps: true });
    const target = join(scratch, 'public', 'index.html');
    mkdirSync(dirname(target), { recursive: true });
    const leading = renderCli(root, ['--html', mixed, '--out', target]);
    expect(leading.status, leading.stderr).toBe(0);
    expect(leading.stdout.trim()).toBe(target);
    expect(readFileSync(target, 'utf-8')).toContain('<title>acme-notes: what the evidence says</title>');
  });

  test('exits 2 on usage, 1 on unusable input', () => {
    const root = skillTree('cli-errors', { deps: true });
    const noDir = renderCli(root, ['--html']);
    expect(noDir.status).toBe(2);
    expect(noDir.stderr).toContain('usage:');
    expect(noDir.stderr).toContain('--html');

    const noOutPath = renderCli(root, [mixed, '--html', '--out']);
    expect(noOutPath.status).toBe(2);

    const empty = renderCli(root, [join(scratch, 'nothing-here'), '--html']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('missing');
  });

  test('without the publish-page dependencies it fails naming its own fix', () => {
    const root = skillTree('cli-nodeps', { deps: false });
    const result = renderCli(root, [mixed, '--html', '--out', join(scratch, 'never.html')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('page renderer unavailable');
    expect(result.stderr).toContain('bun install');
    // The markdown lane carries no such dependency and must stay usable.
    const markdown = renderCli(root, [mixed, '--out', join(scratch, 'brief.md')]);
    expect(markdown.status, markdown.stderr).toBe(0);
  });
});
