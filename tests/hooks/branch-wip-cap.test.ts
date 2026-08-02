import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Rule 10, the branch WIP cap. What is under test is that "unfinished" is
// answered by the forge: a squash-merged branch stays a non-ancestor of the
// default branch forever, so every git-only rule calls it outstanding. The
// merged fixtures are built in that shape and assert the topology counts that
// would have blocked them. A `gh` shim stands in for the forge — it answers
// `auth status` and serves `pr list` from a JSON file each test writes.

const HOOK = join(import.meta.dir, '..', '..', 'hooks', 'claude', 'git-police.sh');

let root: string;
let binDir: string;
let forgeJson: string;
let origin: string;

interface RunOptions {
  prs?: unknown[];
  env?: Record<string, string>;
}

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

function runHook(cwd: string, command: string, options: RunOptions = {}): string {
  writeFileSync(forgeJson, JSON.stringify(options.prs ?? []));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${binDir}:${process.env.PATH}`,
    FORGE_JSON: forgeJson,
    // Worktree fixtures would otherwise stop at rule 5 before reaching rule 10.
    AGENTKIT_ALLOW_SHARED_BRANCH: '1',
  };
  delete env.AGENTKIT_BRANCH_WIP_MAX;
  Object.assign(env, options.env ?? {});
  const res = spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
    env,
  });
  return res.stdout ?? '';
}

let cloneCount = 0;

// A clone per test: the cap counts every local branch, so leftovers from an
// earlier test would decide a later one.
function freshClone(): string {
  const dir = join(root, `clone-${cloneCount++}`);
  execSync(`git clone -q ${origin} ${dir}`, { stdio: 'pipe' });
  git(dir, 'config user.email test@example.com');
  git(dir, 'config user.name test');
  git(dir, 'remote set-head origin main');
  return dir;
}

// Commits on `name`, pushes it so its upstream exists and is not gone, then
// advances main the way a squash merge does — leaving the branch a
// non-ancestor carrying commits of its own.
function squashShape(clone: string, name: string): void {
  git(clone, `checkout -q -b ${name}`);
  git(clone, 'commit -q --allow-empty -m work');
  git(clone, `push -q -u origin ${name}`);
  git(clone, 'checkout -q main');
  git(clone, `commit -q --allow-empty -m "squash of ${name}"`);
  git(clone, 'push -q origin main');
  git(clone, 'fetch -q');
}

function startedBranch(clone: string, name: string): void {
  git(clone, `checkout -q -b ${name}`);
  git(clone, 'commit -q --allow-empty -m work');
  git(clone, 'checkout -q main');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-wipcap-'));
  binDir = join(root, 'bin');
  forgeJson = join(root, 'prs.json');
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash
case "$1 $2" in
  "auth status") exit \${GH_AUTH_EXIT:-0} ;;
  "pr list")
    if [[ "\${GH_LIST_EXIT:-0}" != 0 ]]; then exit "\${GH_LIST_EXIT}"; fi
    if [[ -n "\${GH_LIST_GARBAGE:-}" ]]; then printf '%s\\n' "\${GH_LIST_GARBAGE}"; exit 0; fi
    cat "\${FORGE_JSON}"
    ;;
esac
exit 0
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);

  origin = join(root, 'origin.git');
  execSync(`git init -q --bare -b main ${origin}`, { stdio: 'pipe' });
  const seed = join(root, 'seed');
  execSync(`git clone -q ${origin} ${seed}`, { stdio: 'pipe' });
  git(seed, 'config user.email test@example.com');
  git(seed, 'config user.name test');
  git(seed, 'commit -q --allow-empty -m init');
  git(seed, 'push -q origin main');
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('branch WIP cap: the three outcomes are distinguishable', () => {
  test('clean — a repo with no unfinished branches says nothing at all', () => {
    const clone = freshClone();
    expect(runHook(clone, 'git checkout -b feat/first').trim()).toBe('');
  });

  test('blocked — one started branch with no change raised refuses the next one', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    const out = runHook(clone, 'git checkout -b feat/second');
    expect(out).toContain('"deny"');
    expect(out).toContain('feat/orphan');
    expect(out).toContain('unfinished');
  });

  test('could not check — an unreachable forge advises, and never denies', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    const out = runHook(clone, 'git checkout -b feat/second', { env: { GH_AUTH_EXIT: '1' } });
    expect(out).not.toContain('"deny"');
    expect(out).toContain('additionalContext');
    expect(out).toContain('UNCHECKED');
    expect(out).toContain('feat/orphan');
  });
});

describe('branch WIP cap: only the forge decides what is finished', () => {
  test('squash-merged branches do not count, though topology says they are unmerged', () => {
    const clone = freshClone();
    squashShape(clone, 'feat/merged-a');
    squashShape(clone, 'feat/merged-b');

    // The counterfactual: every git-only rule would have blocked here.
    for (const branch of ['feat/merged-a', 'feat/merged-b']) {
      const ahead = git(clone, `rev-list --count origin/main..${branch}`).trim();
      expect(Number(ahead)).toBeGreaterThan(0);
      expect(git(clone, `merge-base --is-ancestor ${branch} origin/main || echo notancestor`))
        .toContain('notancestor');
    }

    const prs = [
      { headRefName: 'feat/merged-a', state: 'MERGED' },
      { headRefName: 'feat/merged-b', state: 'MERGED' },
    ];
    expect(runHook(clone, 'git checkout -b feat/next', { prs }).trim()).toBe('');
  });

  test('a branch with an open change counts', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/in-review');
    const out = runHook(clone, 'git checkout -b feat/next', {
      prs: [{ headRefName: 'feat/in-review', state: 'OPEN' }],
    });
    expect(out).toContain('"deny"');
    expect(out).toContain('feat/in-review');
  });

  test('a branch whose change was closed without merging does not count', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/abandoned');
    const out = runHook(clone, 'git checkout -b feat/next', {
      prs: [{ headRefName: 'feat/abandoned', state: 'CLOSED' }],
    });
    expect(out.trim()).toBe('');
  });

  test('merged wins over a closed change on the same branch', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/twice');
    const out = runHook(clone, 'git checkout -b feat/next', {
      prs: [
        { headRefName: 'feat/twice', state: 'CLOSED' },
        { headRefName: 'feat/twice', state: 'MERGED' },
      ],
    });
    expect(out.trim()).toBe('');
  });
});

describe('branch WIP cap: what does not count as started', () => {
  test('a branch with nothing committed and no worktree is not unfinished work', () => {
    const clone = freshClone();
    git(clone, 'branch harness/empty-1');
    git(clone, 'branch harness/empty-2');
    expect(runHook(clone, 'git checkout -b feat/next').trim()).toBe('');
  });

  test('a branch with nothing committed but a worktree on it does count', () => {
    const clone = freshClone();
    git(clone, 'branch feat/uncommitted');
    git(clone, `worktree add -q ${join(root, `wt-${cloneCount}`)} feat/uncommitted`);
    const out = runHook(clone, 'git checkout -b feat/next');
    expect(out).toContain('"deny"');
    expect(out).toContain('feat/uncommitted');
  });

  // Rule 7 lets this one through (it cannot be deleted from here), so the cap
  // is what would otherwise accumulate it under worktree-per-branch.
  test('a merged-and-deleted branch held open by a worktree does not count', () => {
    const clone = freshClone();
    git(clone, 'checkout -q -b feat/gone');
    git(clone, 'commit -q --allow-empty -m work');
    git(clone, 'push -q -u origin feat/gone');
    git(clone, 'checkout -q main');
    git(clone, `worktree add -q ${join(root, `wt-gone-${cloneCount}`)} feat/gone`);
    git(clone, 'push -q origin --delete feat/gone');
    git(clone, 'fetch -pq');

    const out = runHook(clone, 'git checkout -b feat/next');
    expect(out).not.toContain('"deny"');
    expect(out).not.toContain('feat/gone');
  });
});

describe('branch WIP cap: a failed forge call is not an empty backlog', () => {
  test('a listing that errors advises instead of denying', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    const out = runHook(clone, 'git checkout -b feat/second', { env: { GH_LIST_EXIT: '1' } });
    expect(out).not.toContain('"deny"');
    expect(out).toContain('UNCHECKED');
  });

  test('a listing that is not a JSON array advises instead of denying', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    const out = runHook(clone, 'git checkout -b feat/second', {
      env: { GH_LIST_GARBAGE: 'gh: could not determine repository' },
    });
    expect(out).not.toContain('"deny"');
    expect(out).toContain('UNCHECKED');
  });

  test('an empty array is a real answer and still blocks', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    const out = runHook(clone, 'git checkout -b feat/second', { prs: [] });
    expect(out).toContain('"deny"');
  });
});

describe('branch WIP cap: overrides', () => {
  test('the inline override named by the refusal actually unblocks the command', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    expect(runHook(clone, 'git checkout -b feat/second')).toContain('AGENTKIT_BRANCH_WIP_MAX=<n>');
    expect(runHook(clone, 'AGENTKIT_BRANCH_WIP_MAX=2 git checkout -b feat/second'))
      .not.toContain('"deny"');
  });

  test('the off switch named by the refusal also unblocks it', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    expect(runHook(clone, 'git checkout -b feat/second')).toContain('AGENTKIT_BRANCH_WIP_MAX=off');
    expect(runHook(clone, 'AGENTKIT_BRANCH_WIP_MAX=off git checkout -b feat/second').trim())
      .toBe('');
  });

  test('the raised limit still blocks once it is reached', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/one');
    startedBranch(clone, 'feat/two');
    const out = runHook(clone, 'AGENTKIT_BRANCH_WIP_MAX=2 git checkout -b feat/three');
    expect(out).toContain('"deny"');
    expect(out).toContain('feat/one');
    expect(out).toContain('feat/two');
  });

  test('the environment override works where an inline prefix cannot reach', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    const out = runHook(clone, 'git checkout -b feat/second', {
      env: { AGENTKIT_BRANCH_WIP_MAX: '5' },
    });
    expect(out.trim()).toBe('');
  });
});

describe('branch WIP cap: GitLab', () => {
  // gh is shimmed to fail authentication here so the real one on the machine
  // cannot answer first and hide whether the GitLab branch works at all.
  let glabBin: string;
  let mrJson: string;

  function runGitlab(cwd: string, command: string, mrs: unknown[]): string {
    writeFileSync(mrJson, JSON.stringify(mrs));
    const res = spawnSync('bash', [HOOK], {
      cwd,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf-8',
      env: {
        ...(process.env as Record<string, string>),
        PATH: `${glabBin}:${process.env.PATH}`,
        MR_JSON: mrJson,
      },
    });
    return res.stdout ?? '';
  }

  beforeAll(() => {
    glabBin = join(root, 'bin-gitlab');
    mrJson = join(root, 'mrs.json');
    mkdirSync(glabBin);
    writeFileSync(join(glabBin, 'gh'), '#!/usr/bin/env bash\nexit 1\n');
    writeFileSync(
      join(glabBin, 'glab'),
      `#!/usr/bin/env bash
case "$2" in
  /version) exit 0 ;;
  *merge_requests*) cat "\${MR_JSON}" ;;
esac
exit 0
`,
    );
    chmodSync(join(glabBin, 'gh'), 0o755);
    chmodSync(join(glabBin, 'glab'), 0o755);
  });

  test('an open merge request on a branch blocks the next branch', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/gl-open');
    const out = runGitlab(clone, 'git checkout -b feat/next', [
      { source_branch: 'feat/gl-open', state: 'opened' },
    ]);
    expect(out).toContain('"deny"');
    expect(out).toContain('feat/gl-open');
  });

  test('a squash-merged branch does not, though topology says it is unmerged', () => {
    const clone = freshClone();
    squashShape(clone, 'feat/gl-merged');
    expect(Number(git(clone, 'rev-list --count origin/main..feat/gl-merged').trim()))
      .toBeGreaterThan(0);
    const out = runGitlab(clone, 'git checkout -b feat/next', [
      { source_branch: 'feat/gl-merged', state: 'merged' },
    ]);
    expect(out.trim()).toBe('');
  });
});

describe('branch WIP cap: scope', () => {
  test('commands that do not create a branch are left alone', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    expect(runHook(clone, 'git status').trim()).toBe('');
    expect(runHook(clone, 'git checkout feat/orphan')).not.toContain('unfinished');
  });

  test('a repo with no remote at all is silent — it has no forge to be unreachable', () => {
    const local = join(root, `local-only-${cloneCount++}`);
    mkdirSync(local);
    for (
      const cmd of [
        'git init -q -b main',
        'git config user.email t@e.com',
        'git config user.name t',
        'git commit -q --allow-empty -m init',
        'git checkout -q -b feat/started',
        'git commit -q --allow-empty -m work',
        'git checkout -q main',
      ]
    ) {
      git(local, cmd.replace(/^git /, ''));
    }
    expect(runHook(local, 'git checkout -b feat/next', { env: { GH_AUTH_EXIT: '1' } }).trim())
      .toBe('');
  });

  test('switch -c is capped exactly as checkout -b is', () => {
    const clone = freshClone();
    startedBranch(clone, 'feat/orphan');
    expect(runHook(clone, 'git switch -c feat/second')).toContain('"deny"');
  });
});
