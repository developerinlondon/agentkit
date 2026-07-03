import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Rule 7 (branch hygiene at branch creation) needs real git state — a clone
// with a deletable origin — so these tests build a fixture repo pair instead
// of mocking.

const HOOK = join(import.meta.dir, '..', 'hooks', 'claude', 'git-police.sh');

function runHook(cwd: string, command: string): string {
  const input = JSON.stringify({ tool_input: { command } });
  const res = spawnSync('bash', [HOOK], { cwd, input, encoding: 'utf-8' });
  return res.stdout ?? '';
}

let root: string;
let origin: string;
let clone: string;

function git(cwd: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: 'pipe' });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-hygiene-'));
  origin = join(root, 'origin.git');
  clone = join(root, 'clone');
  execSync(`git init --bare -b main ${origin}`, { stdio: 'pipe' });
  execSync(`git clone ${origin} ${clone}`, { stdio: 'pipe' });
  git(clone, 'config user.email test@example.com');
  git(clone, 'config user.name test');
  git(clone, 'commit --allow-empty -m init');
  git(clone, 'push -q origin main');
  git(clone, 'remote set-head origin main');
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('git-police branch hygiene (rule 7)', () => {
  test('allows branching from a clean default branch', () => {
    expect(runHook(clone, 'git checkout -b feat/one')).not.toContain('"deny"');
  });

  test('denies stacking a branch on a feature branch', () => {
    git(clone, 'checkout -q -b feat/base');
    const out = runHook(clone, 'git checkout -b feat/stacked');
    expect(out).toContain('"deny"');
    expect(out).toContain('feature branch');
    git(clone, 'checkout -q main');
  });

  test('AGENTKIT_ALLOW_BRANCH_STACKING=1 overrides the stacking rule', () => {
    git(clone, 'checkout -q -b feat/base2');
    const input = JSON.stringify({ tool_input: { command: 'git checkout -b feat/stacked2' } });
    const res = spawnSync('bash', [HOOK], {
      cwd: clone,
      input,
      encoding: 'utf-8',
      env: { ...process.env, AGENTKIT_ALLOW_BRANCH_STACKING: '1' },
    });
    expect(res.stdout ?? '').not.toContain('feature branch');
    git(clone, 'checkout -q main');
  });

  test('denies new branches while gone-upstream branches linger, then allows after cleanup', () => {
    // Simulate a squash-merged branch: push it, delete the remote, fetch -p.
    git(clone, 'checkout -q -b feat/merged-away');
    git(clone, 'commit --allow-empty -m work');
    git(clone, 'push -q -u origin feat/merged-away');
    git(clone, 'checkout -q main');
    git(clone, 'push -q origin --delete feat/merged-away');
    git(clone, 'fetch -pq');

    const denied = runHook(clone, 'git checkout -b feat/next');
    expect(denied).toContain('"deny"');
    expect(denied).toContain('feat/merged-away');

    git(clone, 'branch -D feat/merged-away');
    expect(runHook(clone, 'git checkout -b feat/next')).not.toContain('feat/merged-away');
  });
});

describe('git-police push branch resolution (rule 4)', () => {
  test("denies plain push when the cwd repo is on 'main'", () => {
    git(clone, 'checkout -q main');
    const out = runHook(clone, 'git push origin HEAD');
    expect(out).toContain('"deny"');
    expect(out).toContain("You are on 'main'");
  });

  test('allows git -C push targeting a feature-branch repo while cwd is on main', () => {
    const target = join(root, 'clone-feature');
    execSync(`git clone ${origin} ${target}`, { stdio: 'pipe' });
    git(target, 'checkout -q -b feat/rule4');
    git(clone, 'checkout -q main');
    expect(runHook(clone, `git -C ${target} push -u origin feat/rule4`)).not.toContain('"deny"');
  });

  test('denies git -C push targeting a repo on main even from a non-repo cwd', () => {
    const out = runHook(root, `git -C ${clone} push origin HEAD`);
    expect(out).toContain('"deny"');
    expect(out).toContain("You are on 'main'");
  });
});
