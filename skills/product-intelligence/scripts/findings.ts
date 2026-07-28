// findings.md is written by the analyze pass: the block structure is ours to
// render, the inline content is crawled text. Escaping runs FIRST and the
// formatting pass runs over already-escaped text, so a mistake in the whitelist
// below can only emit a tag this file names — never one the author supplied.
// Nothing parses the result again, so a fence interior survives byte for byte.

import { esc } from './markup.ts';

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const CODE_SPAN = /(`+)([\s\S]+?)\1/;

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '<em>$1</em>');
}

// Code spans are cut out before emphasis so a star inside one stays a star.
export function inline(raw: string): string {
  let rest = esc(raw);
  let out = '';
  for (;;) {
    const span = CODE_SPAN.exec(rest);
    if (!span) return out + emphasis(rest);
    out += emphasis(rest.slice(0, span.index)) + `<code>${span[2]}</code>`;
    rest = rest.slice(span.index + span[0].length);
  }
}

function cellsOf(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((c) => c.trim());
}

function isTable(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (!head?.includes('|') || delim === undefined) return false;
  const marks = cellsOf(delim);
  return marks.length === cellsOf(head).length && marks.every((c) => /^:?-+:?$/.test(c));
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line)
    || QUOTE.test(line) || ITEM.test(line) || isTable(lines, i);
}

function fenceBlock(lines: string[], start: number): [string, number] {
  const open = (FENCE.exec(lines[start]) as RegExpExecArray)[1];
  const info = (FENCE.exec(lines[start]) as RegExpExecArray)[2].trim().split(/\s+/)[0] ?? '';
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j += 1) {
    const close = CLOSE.exec(lines[j]);
    if (close && close[1][0] === open[0] && close[1].length >= open.length) {
      end = j;
      break;
    }
  }
  const body = esc(lines.slice(start + 1, end).join('\n'));
  // mermaid reads its source back out of textContent, which decodes the
  // entities — so the diagram sees the characters the author typed.
  const html = info === 'mermaid'
    ? `<pre class="mermaid">${body}</pre>`
    : `<pre><code${info ? ` class="language-${esc(info)}"` : ''}>${body}\n</code></pre>`;
  return [html, end + 1];
}

function quoteBlock(lines: string[], start: number): [string, number] {
  const inner: string[] = [];
  let i = start;
  for (; i < lines.length; i += 1) {
    const m = QUOTE.exec(lines[i]);
    if (!m) break;
    inner.push(m[1]);
  }
  return [`<blockquote>\n${blocks(inner)}\n</blockquote>`, i];
}

function tableBlock(lines: string[], start: number): [string, number] {
  const head = cellsOf(lines[start]);
  const body: string[][] = [];
  let i = start + 2;
  for (; i < lines.length && lines[i].trim() !== '' && lines[i].includes('|'); i += 1) {
    body.push(cellsOf(lines[i]));
  }
  const rows = body.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`);
  return [
    `<table>\n<thead>\n<tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>\n</thead>\n`
    + `<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`,
    i,
  ];
}

function listBlock(lines: string[], start: number): [string, number] {
  const first = ITEM.exec(lines[start]) as RegExpExecArray;
  const indent = first[1].length;
  const ordered = first[3] !== undefined;
  const sameLevel = (line: string): boolean => {
    const m = ITEM.exec(line);
    return m !== null && m[1].length === indent && (m[3] !== undefined) === ordered;
  };
  const items: string[][] = [];
  let content = 0;
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (sameLevel(line)) {
      const m = ITEM.exec(line) as RegExpExecArray;
      items.push([m[4]]);
      content = m[0].length - m[4].length;
      i += 1;
    } else if (line.trim() === '') {
      const next = lines[i + 1] ?? '';
      if (next.trim() === '' || (!sameLevel(next) && next.search(/\S/) < content)) break;
      loose = true;
      items[items.length - 1].push('');
      i += 1;
    } else {
      items[items.length - 1].push(line.slice(Math.min(content, line.search(/\S/))));
      i += 1;
    }
  }
  const rendered = items.map((item) => {
    const structured = loose || item.some((_, k) => k > 0 && startsBlock(item, k));
    return structured ? `<li>\n${blocks(item)}\n</li>` : `<li>${inline(item.join('\n'))}</li>`;
  });
  const tag = ordered ? 'ol' : 'ul';
  return [`<${tag}>\n${rendered.join('\n')}\n</${tag}>`, i];
}

// The analyze pass's own headings sit inside a section of ours, so its top two
// levels land at h3 — an h1 there would outrank the page's own title, and
// publish-page adopts the first h1 it finds when no title is given.
function block(lines: string[], i: number): [string, number] {
  const line = lines[i];
  if (FENCE.test(line)) return fenceBlock(lines, i);
  const heading = HEADING.exec(line);
  if (heading) {
    const level = Math.min(6, Math.max(3, heading[1].length + 1));
    return [`<h${level}>${inline(heading[2])}</h${level}>`, i + 1];
  }
  if (RULE.test(line)) return ['<hr />', i + 1];
  if (QUOTE.test(line)) return quoteBlock(lines, i);
  if (ITEM.test(line)) return listBlock(lines, i);
  if (isTable(lines, i)) return tableBlock(lines, i);
  const text: string[] = [];
  let end = i;
  while (end < lines.length && lines[end].trim() !== '' && (end === i || !startsBlock(lines, end))) {
    text.push(lines[end]);
    end += 1;
  }
  return [`<p>${inline(text.join('\n'))}</p>`, end];
}

export function blocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i += 1;
      continue;
    }
    const [html, next] = block(lines, i);
    out.push(html);
    i = next;
  }
  return out.join('\n');
}

export function findingsHtml(body: string): string {
  return blocks(body.split('\n'));
}
