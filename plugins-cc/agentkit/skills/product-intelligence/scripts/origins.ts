#!/usr/bin/env bun
// Derives a brief's subject.origins[] from a product declaration's parts, so a
// multi-repo product's evidence sources come from the composition rather than
// from someone retyping them into the brief and drifting.

import { readFileSync } from 'node:fs';
import { type Part, parseDocument, partsOf, validateFile } from './validate.ts';

export interface Origin {
  id: string;
  kind: string;
  target: string;
}

// A service is evidence you acquire by visiting its URL, which is the `site`
// lane; the brief has no separate kind for something that runs.
const ORIGIN_KIND: Record<string, string> = { repo: 'repo', site: 'site', service: 'site' };

export function deriveOrigins(product: unknown): Origin[] {
  return partsOf(product).map((part: Part) => ({
    id: part.id as string,
    kind: ORIGIN_KIND[part.kind as string] as string,
    target: part.target as string,
  }));
}

export function formatOrigins(origins: Origin[]): string {
  const lines = ['subject:', '  origins:'];
  for (const origin of origins) {
    lines.push(`    - id: ${origin.id}`);
    lines.push(`      kind: ${origin.kind}`);
    lines.push(`      target: ${JSON.stringify(origin.target)}`);
  }
  return `${lines.join('\n')}\n`;
}

function key(origin: Origin): string {
  return `${origin.id}|${origin.kind}|${origin.target}`;
}

export function checkOrigins(derived: Origin[], brief: unknown): string[] {
  const declared = (((brief as Record<string, unknown>).subject as Record<string, unknown> | undefined)
    ?.origins ?? []) as Origin[];
  const errors: string[] = [];
  const declaredKeys = new Set(declared.map(key));
  const derivedKeys = new Set(derived.map(key));

  for (const origin of derived) {
    if (!declaredKeys.has(key(origin))) {
      errors.push(`missing origin for part '${origin.id}': ${origin.kind} ${origin.target}`);
    }
  }
  for (const origin of declared) {
    if (!derivedKeys.has(key(origin))) {
      errors.push(`origin '${origin.id}' is not derived from any part: ${origin.kind} ${origin.target}`);
    }
  }
  return errors;
}

function load(path: string): unknown {
  const errors = validateFile(path);
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  return parseDocument(path);
}

if (import.meta.main) {
  const [productPath, flag, briefPath] = process.argv.slice(2);
  const badFlag = flag !== undefined && (flag !== '--json' && flag !== '--check');
  if (!productPath || badFlag || (flag === '--check' && !briefPath)) {
    console.error('usage: origins.ts <product.yaml> [--json | --check <brief.yaml>]');
    process.exit(2);
  }
  const origins = deriveOrigins(load(productPath));
  if (flag === '--check') {
    const drift = checkOrigins(origins, Bun.YAML.parse(readFileSync(briefPath as string, 'utf-8')));
    for (const error of drift) console.error(`error: ${briefPath}: ${error}`);
    if (drift.length > 0) process.exit(1);
    console.log(`ok: ${briefPath} origins match ${productPath}`);
  } else if (flag === '--json') {
    console.log(JSON.stringify(origins, null, 2));
  } else {
    process.stdout.write(formatOrigins(origins));
  }
}
