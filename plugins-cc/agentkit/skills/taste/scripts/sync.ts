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

interface GitRun {
  ok: boolean;
  out: string;
  err: string;
  timedOut: boolean;
}

// protocol.ext.allow is pinned rather than inherited: git's own default refuses
// the ext helper, but a host whose global config re-enabled it would run a
// source's URL as a shell command. Spawned asynchronously so the deadline is a
// timer on a running event loop: a blocking spawn holds its caller's thread,
// leaving the bound no way to fail — drop it and an unresponsive host wedges
// whatever is running this instead of being reported.
async function git(cwd: string, args: string[], timeoutMs: number): Promise<GitRun> {
  const child = Bun.spawn({
    cmd: ['git', '-c', 'advice.detachedHead=false', '-c', 'protocol.ext.allow=never', ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  try {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return { ok: child.exitCode === 0, out: out.trim(), err: err.trim(), timedOut };
  } finally {
    clearTimeout(deadline);
  }
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

async function stage(sources: readonly TasteSource[], workspace: string, timeoutMs: number): Promise<{
  staged: Staged[];
  errors: string[];
}> {
  const staged: Staged[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    const checkout = join(workspace, source.name);
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
export async function syncSources(request: SyncRequest): Promise<SyncResult> {
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
    const { staged, errors: refused } = await stage(
      sources,
      workspace,
      request.timeoutMs ?? STEP_TIMEOUT_MS,
    );
    if (refused.length > 0) return { ok: false, errors: refused, report: [], entries: [] };
    return land(request.cwd, staged, today);
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
