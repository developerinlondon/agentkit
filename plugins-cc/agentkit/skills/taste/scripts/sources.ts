import { YAML } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scalar } from './lint.ts';

export interface TasteSource {
  name: string;
  repo: string;
  ref: string;
  path?: string;
  mode: 'vendored';
}

export interface SourceDeclaration {
  sources: TasteSource[];
  errors: string[];
}

export const SOURCE_KEYS = ['name', 'repo', 'ref', 'path', 'mode'];
const MODES = ['vendored', 'reference'];
// The name keys a directory under .agentkit/tastes-vendor/, so it is a plain
// directory name or it is refused: a source must not be able to choose where in
// the checkout its files land.
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function configFiles(
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return [
    join(cwd, '.agentkit', 'config.yaml'),
    join(configHome, 'agentkit', 'config.yaml'),
  ];
}

export function tasteSection(path: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.taste)) return undefined;
  return parsed.taste;
}

function defaultName(repo: string): string {
  const tail = repo.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return tail.replace(/\.git$/, '');
}

function checkName(name: string, at: string): string[] {
  if (SOURCE_NAME.test(name) && !name.includes('..')) return [];
  return [
    `${at}: name ${JSON.stringify(name)} must be a plain directory name — it keys `
    + '.agentkit/tastes-vendor/, and a source does not choose where in the checkout it lands',
  ];
}

// git parses options after positionals, so a ref of `--upload-pack=...` is a
// program git runs. The fetch call stops that with --end-of-options too; this
// is the outer of two independent stops.
function checkRef(ref: string, at: string): string[] {
  if (REF.test(ref) && !ref.includes('..') && !ref.endsWith('.lock')) return [];
  return [
    `${at}: ref ${JSON.stringify(ref)} must be a plain branch, tag or commit — letters, digits, `
    + 'dot, dash, underscore and slash, starting with a letter or digit. A ref beginning with '
    + '"-" is a git option rather than a ref, and is refused here before git ever sees it.',
  ];
}

function checkPath(path: string | undefined, at: string): string[] {
  if (path === undefined) return [];
  const parts = path.split('/');
  if (!path.startsWith('/') && !parts.includes('..')) return [];
  return [`${at}: path ${JSON.stringify(path)} must be a relative subdirectory of the source`];
}

function checkMode(mode: string, at: string): string[] {
  if (mode === 'vendored') return [];
  if (mode === 'reference') {
    return [
      `${at}: mode: reference is deferred — the per-machine cache is not implemented yet. `
      + 'Declare mode: vendored, which commits the snapshot to this repository.',
    ];
  }
  return [`${at}: mode: ${JSON.stringify(mode)} is not one of ${MODES.join(', ')}`];
}

function readSource(
  entry: unknown,
  index: number,
  origin: string,
): { source?: TasteSource; errors: string[] } {
  const at = `${origin}: taste.sources[${index}]`;
  if (!isRecord(entry)) {
    return { errors: [`${at} is not a source — a source is a mapping of ${SOURCE_KEYS.join(', ')}`] };
  }

  const unknown = Object.keys(entry).filter((key) => !SOURCE_KEYS.includes(key)).sort();
  const repo = scalar(entry.repo);
  const ref = scalar(entry.ref);
  const mode = scalar(entry.mode) ?? 'vendored';
  const path = scalar(entry.path);
  const name = scalar(entry.name) ?? (repo === undefined ? undefined : defaultName(repo));

  const errors = [
    ...(unknown.length > 0
      ? [`${at}: unknown source key: ${unknown.join(', ')} — a source carries ${
        SOURCE_KEYS.join(', ')
      }`]
      : []),
    ...(repo === undefined ? [`${at}: missing repo — a source is a git repository`] : []),
    ...(ref === undefined
      ? [
        `${at}: missing ref — a source is pinned to a tag, branch or commit, never to whatever `
        + 'the default branch says today',
      ]
      : checkRef(ref, at)),
    ...checkMode(mode, at),
    ...(name === undefined ? [] : checkName(name, at)),
    ...checkPath(path, at),
  ];

  if (errors.length > 0 || repo === undefined || ref === undefined || name === undefined) {
    return { errors };
  }
  return { source: { name, repo, ref, path, mode: 'vendored' }, errors: [] };
}

function parseSources(declared: unknown, origin: string): SourceDeclaration {
  if (!Array.isArray(declared)) {
    return { sources: [], errors: [`${origin}: taste.sources must be a list of sources`] };
  }

  const sources: TasteSource[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of declared.entries()) {
    const read = readSource(entry, index, origin);
    errors.push(...read.errors);
    if (read.source === undefined) continue;
    if (seen.has(read.source.name)) {
      errors.push(
        `${origin}: duplicate source name ${JSON.stringify(read.source.name)} — the vendor `
        + 'directory is keyed on it. Give one of them an explicit name.',
      );
      continue;
    }
    seen.add(read.source.name);
    sources.push(read.source);
  }

  return { sources, errors };
}

// The project's list replaces the user's rather than extending it: two lists
// that concatenate would give a machine-local file a say in what a committed,
// reviewed declaration means.
export function readSources(
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): SourceDeclaration {
  for (const path of configFiles(cwd, home, env)) {
    const declared = tasteSection(path)?.sources;
    if (declared !== undefined) return parseSources(declared, path);
  }
  return { sources: [], errors: [] };
}
