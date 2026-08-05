import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inspectTaste, scalar, tasteFiles } from './lint.ts';
import { readSources } from './sources.ts';

export type Layer = 'project' | 'external' | 'user';

export interface TasteRule {
  kind: string;
  match: string;
  remedy: string;
  override?: string;
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
}

function vendored(
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): { dirs: Directory[]; warnings: string[] } {
  const root = join(cwd, '.agentkit', 'tastes-vendor');
  const { sources, errors } = readSources(cwd, home, env);
  const warnings = [...errors];
  const dirs: Directory[] = [];

  for (const source of sources) {
    const dir = join(root, source.name);
    if (isDirectory(dir)) dirs.push({ layer: 'external', dir, source: source.name });
    else {
      warnings.push(
        `${dir}: source ${source.name} is declared but not vendored — run the taste skill's sync `
        + 'and commit the snapshot',
      );
    }
  }

  const declared = sources.map((source) => source.name);
  for (const entry of isDirectory(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || declared.includes(entry.name)) continue;
    warnings.push(
      `${join(root, entry.name)}: vendored but not declared in taste.sources — nothing reads it`,
    );
  }

  return { dirs, warnings };
}

// Project first, then each declared source in the order it was declared, then
// the user layer. Position in taste.sources is the whole precedence rule inside
// the external layer: a later source is subscribed to precisely to win.
function tasteDirectories(
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): { dirs: Directory[]; warnings: string[] } {
  const external = vendored(cwd, home, env);
  return {
    dirs: [
      { layer: 'project', dir: join(cwd, '.agentkit', 'tastes') },
      ...external.dirs,
      { layer: 'user', dir: join(home, '.agentkit', 'tastes') },
    ],
    warnings: external.warnings,
  };
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function readRule(front: Record<string, unknown>): TasteRule | undefined {
  const rule = front.rule;
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return undefined;
  const fields = rule as Record<string, unknown>;
  const kind = scalar(fields.kind);
  const match = scalar(fields.match);
  const remedy = scalar(fields.remedy);
  if (kind === undefined || match === undefined || remedy === undefined) return undefined;
  return { kind, match, remedy, override: scalar(fields.override) };
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
  home: string,
  env: Record<string, string | undefined> = process.env,
): Resolution {
  const winners = new Map<string, ResolvedTaste>();
  const { dirs, warnings } = tasteDirectories(cwd, home, env);

  for (const where of dirs) {
    if (!isDirectory(where.dir)) continue;

    let files: string[];
    try {
      files = tasteFiles(where.dir).sort();
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
      } else if (held.layer === 'external' && taste.layer === 'external') {
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
