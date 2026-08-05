import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { lintTasteDirectory, tasteFiles } from './lint.ts';
import { formatLock, type LockEntry, parseLock, pinnedOn } from './lock.ts';
import { readSources, type TasteSource } from './sources.ts';

export interface SyncRequest {
  cwd: string;
  home?: string;
  env?: Record<string, string | undefined>;
  today?: string;
}

export interface SyncResult {
  ok: boolean;
  errors: string[];
  report: string[];
  entries: LockEntry[];
}

interface Staged {
  source: TasteSource;
  sha: string;
  dir: string;
}

function vendorRoot(cwd: string): string {
  return join(cwd, '.agentkit', 'tastes-vendor');
}

function lockPath(cwd: string): string {
  return join(cwd, '.agentkit', 'tastes.lock');
}

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync({
    cmd: ['git', '-c', 'advice.detachedHead=false', ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

function firstLine(text: string): string {
  return text.split('\n').filter((line) => line.trim() !== '').pop() ?? 'no output';
}

// Shallow, and at the named ref only: a taste set is read, never developed from
// here, so its history is not something this checkout has any use for.
function fetchSource(source: TasteSource, into: string): { sha?: string; error?: string } {
  mkdirSync(into, { recursive: true });
  const steps: string[][] = [
    ['init', '--quiet'],
    ['remote', 'add', 'origin', source.repo],
    ['fetch', '--depth', '1', '--quiet', 'origin', source.ref],
    ['checkout', '--quiet', 'FETCH_HEAD'],
  ];

  for (const args of steps) {
    const step = git(into, args);
    if (step.code !== 0) {
      return {
        error: `${source.name}: could not fetch ref ${JSON.stringify(source.ref)} from `
          + `${source.repo} — ${firstLine(step.err)}`,
      };
    }
  }

  const head = git(into, ['rev-parse', 'FETCH_HEAD']);
  if (head.code !== 0) return { error: `${source.name}: could not resolve ${source.ref}` };
  return { sha: head.out };
}

function tasteRoot(source: TasteSource, checkout: string): { dir?: string; error?: string } {
  const dir = source.path === undefined ? checkout : join(checkout, source.path);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    return { error: `${source.name}: path ${JSON.stringify(source.path)} is not a directory in ${source.ref}` };
  }
  return { dir };
}

// The lint the whole toolchain already gates on, run before a single file is
// copied. A source that cannot pass it is a source whose tastes would be
// skipped one by one at read time, with nobody having agreed to any of it.
function lintSource(source: TasteSource, dir: string): string[] {
  const errors = lintTasteDirectory(dir);
  if (errors.length === 0 && tasteFiles(dir).length === 0) {
    return [`${source.name}: no taste files at ${source.ref} — nothing to vendor`];
  }
  return errors.map((error) => `${source.name}: ${error}`);
}

function stage(sources: readonly TasteSource[], workspace: string): {
  staged: Staged[];
  errors: string[];
} {
  const staged: Staged[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    const checkout = join(workspace, source.name);
    const fetched = fetchSource(source, checkout);
    if (fetched.sha === undefined) {
      errors.push(fetched.error as string);
      continue;
    }
    const root = tasteRoot(source, checkout);
    if (root.dir === undefined) {
      errors.push(root.error as string);
      continue;
    }
    const complaints = lintSource(source, root.dir);
    if (complaints.length > 0) {
      errors.push(...complaints);
      continue;
    }
    staged.push({ source, sha: fetched.sha, dir: root.dir });
  }

  return { staged, errors };
}

// Markdown only. The vendored tree is read as policy, so a source cannot land a
// script, a binary or a symlink in this repository along with its words.
function snapshot(from: string, to: string): number {
  rmSync(to, { recursive: true, force: true });
  const files = tasteFiles(from);
  for (const file of files) {
    const target = join(to, relative(from, file));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target, { dereference: true });
  }
  return files.length;
}

function prune(cwd: string, declared: readonly string[]): string[] {
  const root = vendorRoot(cwd);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];

  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || declared.includes(entry.name)) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed.push(`removed .agentkit/tastes-vendor/${entry.name} — no longer declared`);
  }
  return removed;
}

function heldLock(cwd: string): LockEntry[] {
  try {
    return parseLock(readFileSync(lockPath(cwd), 'utf-8'));
  } catch {
    return [];
  }
}

function land(cwd: string, staged: readonly Staged[], today: string): SyncResult {
  const held = heldLock(cwd);
  const report: string[] = [];
  const entries: LockEntry[] = [];

  for (const { source, sha, dir } of staged) {
    const count = snapshot(dir, join(vendorRoot(cwd), source.name));
    const pin = { name: source.name, repo: source.repo, ref: source.ref, sha };
    entries.push({ ...pin, pinned: pinnedOn(pin, held, today) });
    report.push(`${source.name} ${source.ref} ${sha.slice(0, 12)} — ${count} taste${count === 1 ? '' : 's'}`);
  }

  report.push(...prune(cwd, staged.map(({ source }) => source.name)));
  const lock = formatLock(entries);
  mkdirSync(dirname(lockPath(cwd)), { recursive: true });
  writeFileSync(lockPath(cwd), lock);

  return { ok: true, errors: [], report, entries };
}

// Every source is fetched and linted before anything is written, so a bad
// source cannot leave the tree half-updated: the working-tree diff is the
// review surface, and a partial one would be reviewed as if it were the policy.
export function syncSources(request: SyncRequest): SyncResult {
  const home = request.home ?? homedir();
  const env = request.env ?? process.env;
  const today = request.today ?? new Date().toISOString().slice(0, 10);
  const { sources, errors } = readSources(request.cwd, home, env);

  if (errors.length > 0) return { ok: false, errors, report: [], entries: [] };
  if (sources.length === 0) {
    return {
      ok: true,
      errors: [],
      report: ['no sources declared in taste.sources — nothing to sync'],
      entries: [],
    };
  }

  const workspace = mkdtempSync(join(tmpdir(), 'agentkit-taste-sync-'));
  try {
    const { staged, errors: refused } = stage(sources, workspace);
    if (refused.length > 0) return { ok: false, errors: refused, report: [], entries: [] };
    return land(request.cwd, staged, today);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = syncSources({ cwd: process.argv[2] ?? process.cwd() });
  for (const line of result.report) console.log(line);
  for (const error of result.errors) console.error(error);
  process.exit(result.ok ? 0 : 1);
}
