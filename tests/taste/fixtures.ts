import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { tasteFiles } from '../../skills/taste/scripts/lint.ts';

const created: string[] = [];

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

export function scratch(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-taste-'));
  created.push(root);
  writeFiles(root, files);
  return root;
}

export function removeScratch(): void {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
}

export function taste(name: string, extra: Record<string, string> = {}, body?: string): string {
  const fields = {
    name,
    scope: 'external',
    strength: 'prefer',
    provenance: '2026-08-05 · owner',
    ...extra,
  };
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  const prose = body ?? `The ${name} preference.\n\nWhy: it holds next time.\n\nHow to apply: read it before acting.`;
  return `---\n${lines.join('\n')}\n---\n\n${prose}\n`;
}

export function source(repo: string, extra: Record<string, string> = {}): string {
  const lines = [`    - repo: ${repo}`];
  for (const [key, value] of Object.entries(extra)) lines.push(`      ${key}: ${value}`);
  return lines.join('\n');
}

export function config(...sources: string[]): string {
  return `taste:\n  sources:\n${sources.join('\n')}\n`;
}

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

export interface Remote {
  url: string;
  dir: string;
  head(): string;
  commit(files: Record<string, string>, removed?: string[]): string;
  tag(name: string): void;
}

// A git repository on disk, reached over file:// — the whole external-source
// path exercised with nothing to reach for over the network.
export function remote(files: Record<string, string>): Remote {
  const dir = scratch(files);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'tastes');

  return {
    url: `file://${dir}`,
    dir,
    head: () => git(dir, 'rev-parse', 'HEAD'),
    commit(next: Record<string, string>, removed: string[] = []) {
      writeFiles(dir, next);
      for (const path of removed) rmSync(join(dir, path), { force: true });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'update');
      return git(dir, 'rev-parse', 'HEAD');
    },
    tag: (name: string) => git(dir, 'tag', name),
  };
}

export function treeOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of walk(root)) {
    files[relative(root, path)] = readFileSync(path, 'utf-8');
  }
  return files;
}

function walk(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else found.push(path);
    }
  }
  return found.sort();
}

export function tasteNames(dir: string): string[] {
  return tasteFiles(dir).map((path) => relative(dir, path)).sort();
}
