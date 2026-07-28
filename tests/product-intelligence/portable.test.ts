import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderBriefHtml } from '../../skills/product-intelligence/scripts/html.ts';

const repoRoot = dirname(dirname(import.meta.dir));
const skillRoot = join(repoRoot, 'skills', 'product-intelligence');
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
