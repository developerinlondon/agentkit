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

export interface CanonicalTarget {
  host?: string;
  path: string;
}

// Both schemas advertise a clone URL and `owner/repo` as the same thing, so
// raw string comparison reports one repo as missing and unrecognised at once.
// The path after the host is kept WHOLE: a GitLab subgroup is an ordinary
// segment, and reducing to the last two would make acme/platform/engine and
// other/platform/engine one repository.
export function canonicalTarget(target: string): CanonicalTarget {
  const trimmed = target.trim().replace(/\/+$/, '');
  const scp = /^(?:[\w.-]+@)?([\w.-]+\.[a-z]{2,}):(.+)$/i.exec(trimmed);
  const hostPath = scp
    ? `${scp[1]}/${scp[2]}`
    : trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[\w.-]+@/, '');
  const segments = hostPath.replace(/\.git$/, '').split('/').filter(Boolean);

  // Hostnames are case-insensitive by DNS; the path after them is not, on any
  // forge or web server, so only the host is folded.
  if (!(segments[0] ?? '').includes('.')) return { path: segments.join('/') };
  return { host: (segments[0] as string).toLowerCase(), path: segments.slice(1).join('/') };
}

export function sameTarget(a: Origin, b: Origin): boolean {
  const left = canonicalTarget(a.target);
  const right = canonicalTarget(b.target);
  if (left.path !== right.path) return false;
  return left.host === undefined || right.host === undefined || left.host === right.host;
}

export interface OriginCheck {
  errors: string[];
  notes: string[];
}

// One-directional on purpose: every part must be cited, but a brief may cite
// sources that are not parts — the product repo's own documents, a supplied
// docset — so an unmatched origin is reported without failing the check.
export function checkOrigins(derived: Origin[], brief: unknown): OriginCheck {
  const declared = (((brief as Record<string, unknown>).subject as Record<string, unknown> | undefined)
    ?.origins ?? []) as Origin[];
  const errors: string[] = [];
  const notes: string[] = [];
  const byId = new Map(declared.map((origin) => [origin.id, origin]));

  for (const part of derived) {
    const cited = byId.get(part.id);
    if (!cited) {
      errors.push(`missing origin for part '${part.id}': ${part.kind} ${part.target}`);
    } else if (cited.kind !== part.kind || !sameTarget(part, cited)) {
      errors.push(
        `origin '${part.id}' cites ${cited.kind} ${cited.target}, but the part declares ${part.kind} ${part.target}`,
      );
    }
  }

  const partIds = new Set(derived.map((origin) => origin.id));
  for (const origin of declared) {
    if (!partIds.has(origin.id)) {
      notes.push(`origin '${origin.id}' is not a declared part: ${origin.kind} ${origin.target}`);
    }
  }
  return { errors, notes };
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
    const { errors, notes } = checkOrigins(origins, Bun.YAML.parse(readFileSync(briefPath as string, 'utf-8')));
    for (const note of notes) console.log(`note: ${briefPath}: ${note}`);
    for (const error of errors) console.error(`error: ${briefPath}: ${error}`);
    if (errors.length > 0) {
      console.error(`hint: run '${process.argv[1]} ${productPath}' to print the origins the declaration derives`);
      process.exit(1);
    }
    console.log(`ok: ${briefPath} cites every part declared by ${productPath}`);
  } else if (flag === '--json') {
    console.log(JSON.stringify(origins, null, 2));
  } else {
    process.stdout.write(formatOrigins(origins));
  }
}
