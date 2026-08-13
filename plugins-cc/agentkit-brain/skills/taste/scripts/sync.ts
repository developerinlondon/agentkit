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
import {
  EXTERNAL_DIR,
  externalRoot,
  LEGACY_EXTERNAL_ROOT,
  legacyExternalRoot,
  lockPath,
} from './layout.ts';
import { lintTasteDirectory, tasteFiles } from './lint.ts';
import { formatLock, type LockEntry, parseLock, pinnedOn } from './lock.ts';
import { type Run, runBounded } from './run.ts';
import { readSources, type SourceScope, type TasteSource } from './sources.ts';
import { guardTargets, type Target } from './vendor-guard.ts';

// Per git step. GIT_TERMINAL_PROMPT=0 answers a credential prompt but not a
// name resolution or a TCP connect that never returns, and a session must not
// be held by a host that stopped answering.
export const STEP_TIMEOUT_MS = 60_000;

export interface SyncRequest {
  cwd: string;
  home?: string;
  env?: Record<string, string | undefined>;
  today?: string;
  timeoutMs?: number;
  probe?: (cwd: string, env: Record<string, string | undefined>) => Promise<Target>;
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

interface Store {
  scope: SourceScope;
  label: string;
  root: string;
  legacy: boolean;
  sources: TasteSource[];
}

// protocol.ext.allow is pinned rather than inherited: git's own default refuses
// the ext helper, but a host whose global config re-enabled it would run a
// source's URL as a shell command.
async function git(cwd: string, args: string[], timeoutMs: number): Promise<Run> {
  return await runBounded(
    ['git', '-c', 'advice.detachedHead=false', '-c', 'protocol.ext.allow=never', ...args],
    cwd,
    { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs,
  );
}

function firstLine(text: string): string {
  return text.split('\n').filter((line) => line.trim() !== '').pop() ?? 'no output';
}

// Shallow, and at the named ref only: a taste set is read, never developed from
// here, so its history is not something this checkout has any use for. Both
// values that come from config — the repo and the ref — sit after
// --end-of-options, because git reads options after positionals and would
// otherwise run a ref of `--upload-pack=...` as a program.
async function fetchSource(
  source: TasteSource,
  into: string,
  timeoutMs: number,
): Promise<{ sha?: string; error?: string }> {
  mkdirSync(into, { recursive: true });
  const steps: string[][] = [
    ['init', '--quiet'],
    ['remote', 'add', '--end-of-options', 'origin', source.repo],
    ['fetch', '--depth', '1', '--quiet', '--end-of-options', 'origin', source.ref],
    ['checkout', '--quiet', '--end-of-options', 'FETCH_HEAD'],
  ];

  for (const args of steps) {
    const step = await git(into, args, timeoutMs);
    if (step.timedOut) {
      return {
        error: `${source.name}: ${source.repo} was unreachable within ${
          Math.round(timeoutMs / 1000)
        }s — the fetch was abandoned and nothing was written`,
      };
    }
    if (!step.ok) {
      return {
        error: `${source.name}: could not fetch ref ${JSON.stringify(source.ref)} from `
          + `${source.repo} — ${firstLine(step.err)}`,
      };
    }
  }

  const head = await git(into, ['rev-parse', 'FETCH_HEAD'], timeoutMs);
  if (!head.ok) return { error: `${source.name}: could not resolve ${source.ref}` };
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

// Staged under the declaring scope: a source name is unique only within its own
// store, so one checkout keyed on the name would fetch the machine's source
// onto the repository's.
async function stage(store: Store, workspace: string, timeoutMs: number): Promise<{
  staged: Staged[];
  errors: string[];
}> {
  const staged: Staged[] = [];
  const errors: string[] = [];

  for (const source of store.sources) {
    const checkout = join(workspace, store.scope, source.name);
    const fetched = await fetchSource(source, checkout, timeoutMs);
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

// Only `external/` is swept. The taste files beside it are the owner's own, and
// a prune that reached one would delete a taste no source ever vendored.
function prune(store: Store, declared: readonly string[]): string[] {
  const root = externalRoot(store.root);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];

  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || declared.includes(entry.name)) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed.push(`removed .agentkit/tastes/${EXTERNAL_DIR}/${entry.name} — no longer declared`);
  }
  return removed;
}

// Every declared source has just been re-snapshotted from its pinned ref, so the
// old root holds nothing the new one lacks: dropping it is the move. Done after
// the writes, so an interrupted sync leaves the tree that still binds intact.
function relocate(cwd: string): string[] {
  const legacy = legacyExternalRoot(cwd);
  if (!statSync(legacy, { throwIfNoEntry: false })?.isDirectory()) return [];

  rmSync(legacy, { recursive: true, force: true });
  return [
    `moved .agentkit/${LEGACY_EXTERNAL_ROOT}/ to .agentkit/tastes/${EXTERNAL_DIR}/ — external `
    + 'sources now live under the tastes tree they are read with',
  ];
}

function heldLock(root: string): LockEntry[] {
  try {
    return parseLock(readFileSync(lockPath(root), 'utf-8'));
  } catch {
    return [];
  }
}

function land(store: Store, staged: readonly Staged[], today: string): {
  report: string[];
  entries: LockEntry[];
} {
  if (store.sources.length === 0) {
    return { report: ['no sources declared in brain.taste.sources — nothing to sync'], entries: [] };
  }

  const held = heldLock(store.root);
  const report: string[] = [];
  const entries: LockEntry[] = [];

  for (const { source, sha, dir } of staged) {
    const count = snapshot(dir, join(externalRoot(store.root), source.name));
    const pin = { name: source.name, repo: source.repo, ref: source.ref, sha };
    entries.push({ ...pin, pinned: pinnedOn(pin, held, today) });
    report.push(`${source.name} ${source.ref} ${sha.slice(0, 12)} — ${count} taste${count === 1 ? '' : 's'}`);
  }

  if (store.legacy) report.push(...relocate(store.root));
  report.push(...prune(store, staged.map(({ source }) => source.name)));
  mkdirSync(dirname(lockPath(store.root)), { recursive: true });
  writeFileSync(lockPath(store.root), formatLock(entries, store.label));

  return { report, entries };
}

// The repository's store and the machine's, in the order they resolve. A source
// declared in both places is two subscriptions to one upstream, kept in two
// trees, which is why neither list has to replace the other.
function stores(cwd: string, home: string, sources: readonly TasteSource[]): Store[] {
  return [
    { scope: 'project', label: 'repository', root: cwd, legacy: true, sources: [] },
    { scope: 'user', label: 'machine', root: home, legacy: false, sources: [] },
  ].map((store) => ({
    ...store,
    scope: store.scope as SourceScope,
    sources: sources.filter((source) => source.scope === store.scope),
  }));
}

// Every source at every scope is fetched and linted before anything is written,
// so a bad source cannot leave a tree half-updated: the working-tree diff is
// the review surface, and a partial one would be reviewed as if it were policy.
export async function syncSources(request: SyncRequest): Promise<SyncResult> {
  const home = request.home ?? homedir();
  const env = request.env ?? process.env;
  const today = request.today ?? new Date().toISOString().slice(0, 10);
  const { sources, errors } = readSources(request.cwd, home, env);

  if (errors.length > 0) return { ok: false, errors, report: [], entries: [] };
  const scoped = stores(request.cwd, home, sources);

  const guard = await guardTargets({
    cwd: request.cwd,
    home,
    env,
    project: sources.filter((source) => source.scope === 'project'),
    machine: sources.filter((source) => source.scope === 'user'),
    probe: request.probe,
  });
  if (guard.errors.length > 0) {
    return { ok: false, errors: guard.errors, report: [], entries: [] };
  }

  const workspace = mkdtempSync(join(tmpdir(), 'agentkit-taste-sync-'));
  try {
    const staged = new Map<SourceScope, Staged[]>();
    const refused: string[] = [];
    for (const store of scoped) {
      const run = await stage(store, workspace, request.timeoutMs ?? STEP_TIMEOUT_MS);
      staged.set(store.scope, run.staged);
      refused.push(...run.errors);
    }
    if (refused.length > 0) return { ok: false, errors: refused, report: [], entries: [] };

    const report = [...guard.report];
    const entries: LockEntry[] = [];
    for (const store of scoped) {
      const landed = land(store, staged.get(store.scope) ?? [], today);
      report.push(...landed.report.map((line) => `${store.label}: ${line}`));
      entries.push(...landed.entries);
    }
    return { ok: true, errors: [], report, entries };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await syncSources({ cwd: process.argv[2] ?? process.cwd() });
  for (const line of result.report) console.log(line);
  for (const error of result.errors) console.error(error);
  process.exit(result.ok ? 0 : 1);
}
