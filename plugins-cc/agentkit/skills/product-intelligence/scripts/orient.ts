#!/usr/bin/env bun
// Generates the page an agent reads on landing in a multi-repo workspace: what
// the product is, which parts it has, where each one lives, and where the
// evidence about it sits. Derived from the declaration, never hand-edited.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Part, parseDocument, partsOf, validateFile } from './validate.ts';

type Dict = Record<string, any>;

function collapse(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// A pipe inside a role or target would split the cell and silently shift every
// column after it.
function cell(value: unknown): string {
  return collapse(value).replace(/\|/g, '\\|') || '—';
}

function heading(product: Dict): string[] {
  const name = collapse(product.product?.name);
  const lines = [`# ${name} — workspace orientation`, ''];
  if (product.product?.one_liner) lines.push(collapse(product.product.one_liner), '');
  if (product.product?.homepage) lines.push(`Homepage: <${collapse(product.product.homepage)}>`, '');
  const count = partsOf(product).length;
  lines.push(
    `\`${name}\` is one product spread across ${count} ${count === 1 ? 'part' : 'parts'}. This file`,
    'is generated from the product declaration — edit that, then regenerate.',
    '',
  );
  return lines;
}

// Columns are padded to the width dprint would align them to, so the committed
// example survives a repo-wide format run byte-identical to what this emits.
function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] as string).length))) ?? [];
  const line = (row: string[]) => `| ${row.map((c, i) => c.padEnd(widths[i] as number)).join(' | ')} |`;
  const [header, ...body] = rows as [string[], ...string[][]];
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)];
}

function partsTable(product: Dict): string[] {
  const rows = [['Part', 'Role', 'Kind', 'Where', 'Visibility']];
  for (const part of partsOf(product) as Part[]) {
    rows.push([`\`${cell(part.id)}\``, cell(part.role), cell(part.kind), cell(part.target), cell(part.visibility)]);
  }
  const lines = ['## Parts', '', ...table(rows), ''];

  const described = (partsOf(product) as Part[]).filter((part) => part.description);
  if (described.length > 0) {
    lines.push('### What each part holds', '');
    for (const part of described) lines.push(`- **${cell(part.id)}** — ${collapse(part.description)}`);
    lines.push('');
  }
  return lines;
}

function evidenceSection(product: Dict): string[] {
  const evidence = (product.evidence ?? {}) as Dict;
  const entries = Object.entries(evidence).filter(([, value]) => typeof value === 'string');
  if (entries.length === 0 && !product.site) return [];

  const lines = ['## Evidence and published page', ''];
  for (const [field, value] of entries) lines.push(`- ${field}: \`${cell(value)}\``);
  if (product.site?.entry) lines.push(`- site entry: \`${cell(product.site.entry)}\``);
  if (product.site?.published_at) lines.push(`- published at: <${collapse(product.site.published_at)}>`);
  lines.push('', 'Paths are relative to the product declaration.', '');
  return lines;
}

// States the convention, never that the components currently follow it — this
// page is generated, and a generated page that reports unverified state as
// fact is the failure the skill exists to prevent.
function conventionSection(): string[] {
  return [
    '## Working here',
    '',
    'Each part above is a separate repo or service with its own clone. The',
    'convention is that a component names the part it is with a `part_of` block in',
    'its `.agentkit/product.yaml`, reusing the id from this table. A component',
    'without one is still reachable from here, but does not point back.',
    '',
  ];
}

export function renderOrientation(productPath: string): string {
  const errors = validateFile(productPath);
  if (errors.length > 0) throw new Error(`invalid declaration:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  const product = parseDocument(productPath) as Dict;
  return [
    ...heading(product),
    ...partsTable(product),
    ...evidenceSection(product),
    ...conventionSection(),
  ].join('\n');
}

if (import.meta.main) {
  const [productPath, outFlag, outPath] = process.argv.slice(2);
  if (!productPath || (outFlag && (outFlag !== '--out' || !outPath))) {
    console.error('usage: orient.ts <product.yaml> [--out <file>]');
    process.exit(2);
  }
  try {
    const page = renderOrientation(productPath);
    const target = outPath ?? join(dirname(productPath), 'ORIENTATION.md');
    writeFileSync(target, page);
    console.log(target);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}
