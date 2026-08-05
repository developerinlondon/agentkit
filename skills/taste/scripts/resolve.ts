import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inspectTaste, scalar, tasteFiles } from './lint.ts';

export type Layer = 'project' | 'external' | 'user';

// Highest first. A name found at two layers resolves to the higher one
// outright — two tastes are never merged into a third nobody wrote.
const LAYERS: readonly Layer[] = ['project', 'external', 'user'];

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
  shadows: Layer[];
}

export interface Resolution {
  tastes: ResolvedTaste[];
  warnings: string[];
}

function tasteDirectories(cwd: string, home: string): { layer: Layer; dir: string }[] {
  const dirs: Record<Layer, string> = {
    project: join(cwd, '.agentkit', 'tastes'),
    external: join(cwd, '.agentkit', 'tastes-vendor'),
    user: join(home, '.agentkit', 'tastes'),
  };
  return LAYERS.map((layer) => ({ layer, dir: dirs[layer] }));
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

function load(path: string, layer: Layer): { taste?: ResolvedTaste; warning?: string } {
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
      layer,
      path,
      strength: scalar(front.strength) ?? 'prefer',
      enforce: scalar(front.enforce) ?? 'advise',
      category: scalar(front.category),
      rule: readRule(front),
      shadows: [],
    },
  };
}

// Every taste directory that exists, validated by the same lint that gates them
// in CI. A file the lint refuses is skipped and named: a broken taste must cost
// its own enforcement and nobody else's.
export function resolveTastes(cwd: string, home: string): Resolution {
  const winners = new Map<string, ResolvedTaste>();
  const warnings: string[] = [];

  for (const { layer, dir } of tasteDirectories(cwd, home)) {
    if (!isDirectory(dir)) continue;

    let files: string[];
    try {
      files = tasteFiles(dir).sort();
    } catch (error) {
      warnings.push(`${dir}: unreadable — ${(error as Error).message}`);
      continue;
    }

    for (const file of files) {
      const { taste, warning } = load(file, layer);
      if (warning !== undefined) {
        warnings.push(warning);
        continue;
      }
      if (taste === undefined) continue;

      const held = winners.get(taste.name);
      if (held === undefined) {
        winners.set(taste.name, taste);
      } else if (held.layer === layer) {
        warnings.push(
          `${taste.path}: duplicate name ${JSON.stringify(taste.name)} — ${held.path} enforces`,
        );
      } else {
        held.shadows.push(layer);
      }
    }
  }

  return {
    tastes: [...winners.values()].sort((left, right) => left.name.localeCompare(right.name)),
    warnings,
  };
}
