import { YAML } from 'bun';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scalar } from './lint.ts';

// Where a source was declared, which decides where its snapshot lands: a
// repository's own config vendors into that repository, the machine's config
// into the owner's home directory. Nothing about a machine-level source is ever
// copied into a checkout.
export type SourceScope = 'project' | 'user';

export type SourceVisibility = 'public' | 'private';

export interface TasteSource {
  name: string;
  repo: string;
  ref: string;
  path?: string;
  mode: 'vendored';
  scope: SourceScope;
  origin: string;
  visibility?: SourceVisibility;
}

export interface SourceDeclaration {
  sources: TasteSource[];
  errors: string[];
}

export const SOURCE_KEYS = ['name', 'repo', 'ref', 'path', 'mode', 'visibility'];
export const VISIBILITIES: SourceVisibility[] = ['public', 'private'];
const MODES = ['vendored', 'reference'];
// The name keys a directory under .agentkit/tastes/external/, so it is a plain
// directory name or it is refused: a source must not be able to choose where in
// the checkout its files land.
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const TRANSPORT_HELPER = /^[a-z][a-z0-9+.-]*::/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function configFiles(
  cwd: string,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return [
    join(cwd, '.agentkit', 'config.yaml'),
    join(configHome, 'agentkit', 'config.yaml'),
  ];
}

// The order configFiles is written in, named: the first entry is the
// repository's own config, the second the machine's.
export const CONFIG_SCOPES: SourceScope[] = ['project', 'user'];

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
    + '.agentkit/tastes/external/, and a source does not choose where in the checkout it lands',
  ];
}

// `scheme::command` is git's transport-helper syntax: the remote runs a program
// rather than naming a repository. Sync pins that off too.
function checkRepo(repo: string, at: string): string[] {
  if (repo.startsWith('-')) {
    return [`${at}: repo ${JSON.stringify(repo)} begins with "-", which git reads as an option`];
  }
  if (!TRANSPORT_HELPER.test(repo)) return [];
  return [
    `${at}: repo ${JSON.stringify(repo)} names a git transport helper rather than a repository `
    + '— that form runs a program. Use an ssh, https, git or file URL, or a path.',
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

// Absent is not an error here: at the machine scope the key is optional, and at
// the repository scope it is the vendoring that refuses, naming what it needs.
// A value that is neither word is always wrong.
function checkVisibility(visibility: string | undefined, at: string): string[] {
  if (visibility === undefined || VISIBILITIES.includes(visibility as SourceVisibility)) return [];
  return [
    `${at}: visibility ${JSON.stringify(visibility)} is not one of ${VISIBILITIES.join(', ')}`,
  ];
}

function readSource(
  entry: unknown,
  index: number,
  origin: string,
  scope: SourceScope,
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
  const visibility = scalar(entry.visibility);
  const name = scalar(entry.name) ?? (repo === undefined ? undefined : defaultName(repo));

  const errors = [
    ...checkVisibility(visibility, at),
    ...(unknown.length > 0
      ? [`${at}: unknown source key: ${unknown.join(', ')} — a source carries ${
        SOURCE_KEYS.join(', ')
      }`]
      : []),
    ...(repo === undefined
      ? [`${at}: missing repo — a source is a git repository`]
      : checkRepo(repo, at)),
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
  return {
    source: {
      name,
      repo,
      ref,
      path,
      mode: 'vendored',
      scope,
      origin,
      // Nothing of a machine-level source is ever committed anywhere, so the
      // safe reading is free: it defaults to the one that would refuse if this
      // source were ever moved into a repository.
      visibility: (visibility as SourceVisibility | undefined)
        ?? (scope === 'user' ? 'private' : undefined),
    },
    errors: [],
  };
}

function parseSources(declared: unknown, origin: string, scope: SourceScope): SourceDeclaration {
  if (!Array.isArray(declared)) {
    return { sources: [], errors: [`${origin}: taste.sources must be a list of sources`] };
  }

  const sources: TasteSource[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of declared.entries()) {
    const read = readSource(entry, index, origin, scope);
    errors.push(...read.errors);
    if (read.source === undefined) continue;
    if (seen.has(read.source.name)) {
      errors.push(
        `${origin}: duplicate source name ${JSON.stringify(read.source.name)} — the external `
        + 'directory is keyed on it. Give one of them an explicit name.',
      );
      continue;
    }
    seen.add(read.source.name);
    sources.push(read.source);
  }

  return { sources, errors };
}

// Both lists apply, and each vendors into its own store: the repository's into
// the checkout, the machine's into the owner's home directory. They cannot
// collide, so neither has to replace the other — the repository's are simply
// read first, which is the whole of the precedence between them.
export function readSources(
  cwd: string,
  home?: string,
  env?: Record<string, string | undefined>,
): SourceDeclaration {
  const sources: TasteSource[] = [];
  const errors: string[] = [];

  for (const [index, path] of configFiles(cwd, home, env).entries()) {
    const declared = tasteSection(path)?.sources;
    if (declared === undefined) continue;
    const read = parseSources(declared, path, CONFIG_SCOPES[index] as SourceScope);
    sources.push(...read.sources);
    errors.push(...read.errors);
  }

  return { sources, errors };
}
