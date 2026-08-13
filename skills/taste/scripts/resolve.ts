import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { EXTERNAL_DIR, externalRoot, legacyExternalRoot, tastesRoot } from './layout.ts';
import { inspectTaste, scalar, tasteFiles } from './lint.ts';
import { readSources, type SourceScope, type TasteSource } from './sources.ts';

// Two locations, and within each the owner's own files above the ones they
// pulled in. Naming all four is what lets a listing say which store a winner
// came from — "external shadowed external" answers nothing.
export type Layer = 'project' | 'project-external' | 'user' | 'user-external';

export interface TasteRule {
  kind: string;
  remedy: string;
  override?: string;
  // Everything else in the block, kind by kind: `match` for a command rule,
  // `policy` for a tag-sequence one. The resolver stays out of the vocabulary
  // so a kind can be added without it learning anything.
  fields: Record<string, string>;
}

export interface ResolvedTaste {
  name: string;
  layer: Layer;
  path: string;
  strength: string;
  enforce: string;
  category?: string;
  rule?: TasteRule;
  source?: string;
  shadows: Layer[];
  shadowedSources: string[];
}

export interface Resolution {
  tastes: ResolvedTaste[];
  warnings: string[];
}

interface Directory {
  layer: Layer;
  dir: string;
  source?: string;
  skipTop?: string;
}

function undeclared(root: string, declared: readonly string[]): string[] {
  const warnings: string[] = [];
  for (const entry of isDirectory(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || declared.includes(entry.name)) continue;
    warnings.push(
      `${join(root, entry.name)}: vendored but not declared in brain.taste.sources — nothing reads it`,
    );
  }
  return warnings;
}

interface Store {
  scope: SourceScope;
  root: string;
  own: Layer;
  external: Layer;
  // The pre-`external/` location only ever existed inside a repository, so only
  // the repository store reads it for its release of grace.
  legacy: boolean;
  advice: string;
}

const STORES: readonly Omit<Store, 'root'>[] = [
  {
    scope: 'project',
    own: 'project',
    external: 'project-external',
    legacy: true,
    advice: 'run the taste skill\'s sync and commit the snapshot',
  },
  {
    scope: 'user',
    own: 'user',
    external: 'user-external',
    legacy: false,
    advice: 'run the taste skill\'s sync',
  },
];

function external(
  store: Store,
  sources: readonly TasteSource[],
): { dirs: Directory[]; warnings: string[] } {
  const root = externalRoot(store.root);
  const legacy = store.legacy ? legacyExternalRoot(store.root) : undefined;
  const warnings: string[] = [];
  const dirs: Directory[] = [];
  let moved = false;

  for (const source of sources) {
    const dir = join(root, source.name);
    const before = legacy === undefined ? undefined : join(legacy, source.name);
    if (isDirectory(dir)) dirs.push({ layer: store.external, dir, source: source.name });
    else if (before !== undefined && isDirectory(before)) {
      moved = true;
      dirs.push({ layer: store.external, dir: before, source: source.name });
    } else {
      warnings.push(
        `${dir}: source ${source.name} is declared but not vendored — ${store.advice}`,
      );
    }
  }

  // One line, once: the old location still binds for a release, and saying so
  // per source would bury the one instruction that ends it.
  if (moved && legacy !== undefined) {
    warnings.push(
      `${legacy}: read from the old external location — run the taste skill's sync to move it to `
      + `${root}`,
    );
  }

  const declared = sources.map((source) => source.name);
  warnings.push(...undeclared(root, declared));
  if (legacy !== undefined) warnings.push(...undeclared(legacy, declared));

  return { dirs, warnings };
}

// The more specific location wins, and inside one location the owner's own
// files beat the ones they pulled in. Position in brain.taste.sources is the whole
// precedence rule among sources: a later one is subscribed to precisely to win.
//
// An own layer stops at `external/`: the same files read as both would give a
// source the precedence the owner's own tastes hold over it.
function tasteDirectories(
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): { dirs: Directory[]; warnings: string[] } {
  const { sources, errors } = readSources(cwd, home, env);
  const dirs: Directory[] = [];
  const warnings = [...errors];

  for (const shape of STORES) {
    const store: Store = { ...shape, root: shape.scope === 'project' ? cwd : home };
    const pulled = external(store, sources.filter((source) => source.scope === store.scope));
    dirs.push(
      { layer: store.own, dir: tastesRoot(store.root), skipTop: EXTERNAL_DIR },
      ...pulled.dirs,
    );
    warnings.push(...pulled.warnings);
  }

  return { dirs, warnings };
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function readRule(front: Record<string, unknown>): TasteRule | undefined {
  const rule = front.rule;
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return undefined;
  const block = rule as Record<string, unknown>;
  const kind = scalar(block.kind);
  const remedy = scalar(block.remedy);
  if (kind === undefined || remedy === undefined) return undefined;

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(block)) {
    const text = scalar(value);
    if (text !== undefined) fields[key] = text;
  }
  return { kind, remedy, override: scalar(block.override), fields };
}

function load(path: string, where: Directory): { taste?: ResolvedTaste; warning?: string } {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf-8');
  } catch (error) {
    return { warning: `${path}: unreadable — ${(error as Error).message}` };
  }

  const inspection = inspectTaste(basename(path), contents);
  if (inspection.errors.length > 0) {
    return { warning: `${path}: ${inspection.errors.join('; ')}` };
  }

  const front = inspection.front ?? {};
  return {
    taste: {
      name: inspection.name as string,
      layer: where.layer,
      path,
      strength: scalar(front.strength) ?? 'prefer',
      enforce: scalar(front.enforce) ?? 'advise',
      category: scalar(front.category),
      rule: readRule(front),
      source: where.source,
      shadows: [],
      shadowedSources: [],
    },
  };
}

// What lost is recorded on what won, because "why is my project taste not
// firing" is answered by the layer and the source that replaced it, never by
// the winner alone.
function lose(winner: ResolvedTaste, loser: ResolvedTaste): void {
  if (!winner.shadows.includes(loser.layer)) winner.shadows.push(loser.layer);
  for (const source of [loser.source, ...loser.shadowedSources]) {
    if (source !== undefined && !winner.shadowedSources.includes(source)) {
      winner.shadowedSources.push(source);
    }
  }
}

// Every taste directory that exists, validated by the same lint that gates them
// in CI. A file the lint refuses is skipped and named: a broken taste must cost
// its own enforcement and nobody else's.
export function resolveTastes(
  cwd: string,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): Resolution {
  const winners = new Map<string, ResolvedTaste>();
  const { dirs, warnings } = tasteDirectories(cwd, home, env);

  for (const where of dirs) {
    if (!isDirectory(where.dir)) continue;

    let files: string[];
    try {
      files = tasteFiles(where.dir, where.skipTop).sort();
    } catch (error) {
      warnings.push(`${where.dir}: unreadable — ${(error as Error).message}`);
      continue;
    }

    for (const file of files) {
      const { taste, warning } = load(file, where);
      if (warning !== undefined) {
        warnings.push(warning);
        continue;
      }
      if (taste === undefined) continue;

      const held = winners.get(taste.name);
      if (held === undefined) {
        winners.set(taste.name, taste);
      } else if (held.layer === taste.layer && held.source === taste.source) {
        warnings.push(
          `${taste.path}: duplicate name ${JSON.stringify(taste.name)} — ${held.path} enforces`,
        );
      } else if (held.layer === taste.layer) {
        lose(taste, held);
        winners.set(taste.name, taste);
      } else {
        lose(held, taste);
      }
    }
  }

  return {
    tastes: [...winners.values()].sort((left, right) => left.name.localeCompare(right.name)),
    warnings,
  };
}
