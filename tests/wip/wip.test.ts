import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  commitFile,
  git,
  makeSandbox,
  makeSquashMergeRepo,
  repoRoot,
  restrictedPath,
  run,
  type Sandbox,
  writeExecutable,
} from './fixture';

const wip = join(repoRoot, 'tools', 'wip');

const BARE_TOOLS = ['bash', 'git', 'jq', 'sed', 'grep', 'date', 'wc', 'cut', 'head', 'tr', 'cat', 'find', 'sort'];

let box: Sandbox;
let repo: string;

beforeEach(() => {
  box = makeSandbox('wip-');
  repo = makeSquashMergeRepo(box);
});

afterEach(() => {
  rmSync(box.root, { recursive: true, force: true });
});

function report(args: string[] = ['--no-forge'], overrides: Record<string, string> = {}) {
  const result = run([wip, ...args, repo], box, box.root, overrides);
  expect(result.status).toBe(0);
  return result.stdout;
}

function lineFor(output: string, label: string, needle: string): string | undefined {
  return output.split('\n').find((line) => line.includes(` ${label} `) && line.includes(needle));
}

const PR = (number: number, headRefName: string, state: string) => ({ number, headRefName, state });

// The forge is the only authority on a squash merge. `feat/squashed` in this
// fixture is squash-merged in git terms — its content is on main and its
// commits are not ancestors of anything — so every classification below is a
// statement about what the forge says, not about git topology.
function installFakeGh(
  prs: unknown[],
  issues: unknown[] = [],
  byHead: Record<string, unknown[]> = {},
): void {
  writeExecutable(
    join(box.binDir, 'gh'),
    [
      '#!/usr/bin/env bash',
      // Listing resolves the repository from gh's own working directory, so a
      // caller that queries from elsewhere silently gets nothing back. Auth
      // status reads config and works anywhere, as the real gh does.
      `inrepo() { [[ "$PWD" == "${repo}" ]] || exit 1; }`,
      'case "$*" in',
      '  *"auth status"*) exit 0 ;;',
      ...Object.entries(byHead).map(([branch, rows]) =>
        `  *"--head ${branch}"*) inrepo; printf '%s' '${JSON.stringify(rows)}' ;;`
      ),
      `  *"--head "*) inrepo; printf '%s' '[]' ;;`,
      `  *"pr list"*) inrepo; printf '%s' '${JSON.stringify(prs)}' ;;`,
      `  *"issue list"*) inrepo; printf '%s' '${JSON.stringify(issues)}' ;;`,
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'),
  );
}

function withForge(prs: unknown[], byHead: Record<string, unknown[]> = {}) {
  installFakeGh(prs, [], byHead);
  return run([wip, '--limit', '0', repo], box, box.root).stdout;
}

describe('branch state comes from the forge, not from git topology', () => {
  test('a squash-merged branch the forge calls merged is cleanup, not unfinished work', () => {
    const out = withForge([PR(1, 'feat/squashed', 'MERGED')]);
    expect(lineFor(out, 'BRANCH', 'feat/squashed')).toBeUndefined();
    expect(lineFor(out, 'MERGED', 'feat/squashed')).toBeDefined();
    expect(out).toContain('cleanup, not unfinished work');
  });

  test('a branch with an open change is in flight and names its reference', () => {
    const line = lineFor(withForge([PR(7, 'feat/unmerged', 'OPEN')]), 'BRANCH', 'feat/unmerged') ?? '';
    expect(line).toContain('#7 open');
  });

  test('a branch closed without merging is abandoned, not outstanding and not merged', () => {
    const out = withForge([PR(9, 'feat/unmerged', 'CLOSED')]);
    const line = lineFor(out, 'ABANDONED', 'feat/unmerged') ?? '';
    expect(line).toContain('#9 closed without merging');
    expect(lineFor(out, 'BRANCH', 'feat/unmerged')).toBeUndefined();
    expect(lineFor(out, 'MERGED', 'feat/unmerged')).toBeUndefined();
  });

  test('a branch the forge has never seen is the genuinely interesting case', () => {
    const line = lineFor(withForge([]), 'BRANCH', 'feat/unmerged') ?? '';
    expect(line).toContain('no MR/PR ever opened');
  });

  test('one merged change outranks a closed one on the same branch', () => {
    const out = withForge([PR(2, 'feat/squashed', 'CLOSED'), PR(3, 'feat/squashed', 'MERGED')]);
    expect(lineFor(out, 'MERGED', 'feat/squashed')).toBeDefined();
    expect(lineFor(out, 'ABANDONED', 'feat/squashed')).toBeUndefined();
  });

  test('a branch older than the bulk listing window is asked for by name', () => {
    // The bulk query is capped, so a branch missing from it must be queried
    // directly rather than silently reported as never having had a change.
    const out = withForge([], { 'feat/squashed': [PR(4, 'feat/squashed', 'MERGED')] });
    expect(lineFor(out, 'MERGED', 'feat/squashed')).toBeDefined();
    expect(lineFor(out, 'BRANCH', 'feat/squashed')).toBeUndefined();
  });

  test('a deleted upstream branch is annotated, not treated as an answer', () => {
    git(repo, box, 'update-ref', 'refs/remotes/origin/feat/unmerged', 'feat/unmerged');
    git(repo, box, 'branch', '--set-upstream-to=origin/feat/unmerged', 'feat/unmerged');
    git(repo, box, 'update-ref', '-d', 'refs/remotes/origin/feat/unmerged');
    const line = lineFor(withForge([]), 'BRANCH', 'feat/unmerged') ?? '';
    expect(line).toContain('upstream branch deleted');
    expect(line).toContain('no MR/PR ever opened');
  });

  test('an unreachable forge says the state is unknown instead of guessing', () => {
    const out = report([], { PATH: restrictedPath(box, BARE_TOOLS) });
    expect(lineFor(out, 'BRANCH', 'feat/squashed')).toContain('state UNKNOWN');
    expect(out).toContain('branch state is DEGRADED');
    // The alarming direction: never claim work is outstanding, or finished,
    // when nothing could answer.
    expect(out).not.toContain('cleanup, not unfinished work');
    expect(out).not.toContain('no MR/PR ever opened');
  });

  test('an unmerged branch reports its age and commit count', () => {
    const line = lineFor(withForge([]), 'BRANCH', 'feat/unmerged') ?? '';
    expect(line).toMatch(/\d+d/);
    expect(line).toMatch(/1 commits/);
  });
});

describe('worktrees', () => {
  test('a dirty worktree is flagged and warned against removing', () => {
    const wt = join(box.root, 'wt-dirty');
    git(repo, box, 'worktree', 'add', '-q', wt, 'feat/unmerged');
    writeFileSync(join(wt, 'b.txt'), 'edited\n');
    writeFileSync(join(wt, 'scratch.tmp'), 'untracked\n');

    const line = lineFor(report(), 'WORKTREE', 'feat/unmerged') ?? '';
    expect(line).toContain('DIRTY');
    expect(line).toContain('1 modified');
    expect(line).toContain('1 untracked');
    expect(line).toContain('do NOT remove');
    expect(line).toContain(wt);
  });

  test('a clean worktree is reported without the warning', () => {
    const wt = join(box.root, 'wt-clean');
    git(repo, box, 'worktree', 'add', '-q', wt, 'feat/unmerged');
    const line = lineFor(report(), 'WORKTREE', 'feat/unmerged') ?? '';
    expect(line).toContain('clean');
    expect(line).not.toContain('DIRTY');
  });

  test('a worktree on a merged branch is marked cleanup, not unfinished work', () => {
    const wt = join(box.root, 'wt-merged');
    git(repo, box, 'worktree', 'add', '-q', wt, 'feat/squashed');
    const out = withForge([PR(1, 'feat/squashed', 'MERGED')]);
    const line = lineFor(out, 'WORKTREE', 'feat/squashed') ?? '';
    expect(line).toContain('branch already merged — cleanup');
    expect(lineFor(out, 'BRANCH', 'feat/squashed')).toBeUndefined();
  });

  test('the primary checkout is not listed as a worktree of itself', () => {
    expect(report()).not.toContain('WORKTREE');
  });
});

describe('plans', () => {
  test('a plan with an unclosed gap is surfaced read-only', () => {
    mkdirSync(join(repo, 'plans'), { recursive: true });
    writeFileSync(
      join(repo, 'plans', '057.md'),
      '# P\n\n## Known gaps\n\n- no UI for exec_mode\n- tracked one #4\n',
    );
    const line = lineFor(report(), 'PLAN', 'plans/057.md') ?? '';
    expect(line).toContain('1 gap(s) unclosed');
  });
});

describe('forge degradation', () => {
  test('a repository whose forge CLI is absent says so instead of showing nothing', () => {
    const out = report([], { PATH: restrictedPath(box, BARE_TOOLS) });
    expect(out).toContain('NOTE');
    expect(out).toContain('not checked');
    expect(lineFor(out, 'BRANCH', 'feat/unmerged')).toBeDefined();
  });

  test('a github repository without gh names gh as the missing piece', () => {
    git(repo, box, 'remote', 'set-url', 'origin', 'git@github.com:acme/fixture.git');
    const out = report([], { PATH: restrictedPath(box, BARE_TOOLS) });
    expect(out).toContain('gh is not installed');
  });

  test('a gitlab repository without glab names glab as the missing piece', () => {
    git(repo, box, 'remote', 'set-url', 'origin', 'git@gitlab.example.com:acme/fixture.git');
    const out = report([], { PATH: restrictedPath(box, BARE_TOOLS) });
    expect(out).toContain('glab is unavailable or unauthenticated');
  });

  test('--no-forge names itself as the reason the sections are missing', () => {
    expect(report()).toContain('skipped (--no-forge)');
  });

  test('a repository with no origin remote is reported, not crashed on', () => {
    git(repo, box, 'remote', 'remove', 'origin');
    const result = run([wip, repo], box, box.root, { PATH: restrictedPath(box, BARE_TOOLS) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no origin remote');
  });

  test('a path that is not a repository fails loudly', () => {
    const result = run([wip, box.home], box, box.root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not a git repository');
  });
});

describe('forge sections', () => {
  test('an open change reports what holds it, and binds to its branch', () => {
    installFakeGh(
      [{
        number: 42,
        headRefName: 'feat/unmerged',
        state: 'OPEN',
        isDraft: true,
        mergeable: 'CONFLICTING',
        reviewDecision: '',
        statusCheckRollup: [{ conclusion: 'FAILURE' }],
      }],
      [],
    );
    const out = report([]);
    const change = lineFor(out, 'MR/PR', '#42') ?? '';
    expect(change).toContain('draft');
    expect(change).toContain('conflicts');
    expect(change).toContain('checks failing');
    expect(change).toContain('no approving review');
    expect(lineFor(out, 'BRANCH', 'feat/unmerged')).toContain('#42');
  });

  test('a branch with no change of its own says so', () => {
    installFakeGh([], []);
    expect(lineFor(report([]), 'BRANCH', 'feat/unmerged')).toContain('no MR/PR');
  });

  test('an approved, clean change reports nothing holding it', () => {
    installFakeGh(
      [{
        number: 7,
        headRefName: 'feat/unmerged',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }],
      [],
    );
    expect(lineFor(report([]), 'MR/PR', '#7')).toContain('nothing — ready');
  });

  test('issues carved out of other work are separated from the rest', () => {
    installFakeGh([], [
      { number: 11, title: 'plain bug', body: 'it breaks' },
      { number: 12, title: 'exec UI', body: 'Split out of #10 so that plan can close.' },
    ]);
    const out = report([]);
    expect(lineFor(out, 'FILED', '#11')).toBeDefined();
    expect(lineFor(out, 'DEFERRED', '#12')).toBeDefined();
    expect(lineFor(out, 'FILED', '#12')).toBeUndefined();
  });

  test('the merged-cleanup list is bounded and says how many it dropped', () => {
    const merged: unknown[] = [];
    for (let i = 0; i < 8; i += 1) {
      git(repo, box, 'branch', `merged/${i}`, 'main');
      merged.push({ number: 100 + i, headRefName: `merged/${i}`, state: 'MERGED' });
    }
    installFakeGh(merged, []);
    const out = report(['--limit', '3']);
    const line = lineFor(out, 'MERGED', '+') ?? '';
    expect(line).toContain('more (--limit 0 for all)');
  });

  test('a bounded list says how many it dropped', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: 't', body: 'b' }));
    installFakeGh([], many);
    const out = report(['--limit', '5']);
    expect(lineFor(out, 'FILED', '+25 more')).toBeDefined();
    expect(out).toContain('--limit 0 for all');
  });
});

describe('several repositories', () => {
  test('each repository gets its own heading and count', () => {
    const second = join(box.root, 'second');
    mkdirSync(second, { recursive: true });
    git(second, box, 'init', '-q', '-b', 'main');
    commitFile(second, box, 'x.md', 'x\n', 'init');

    const result = run([wip, '--no-forge', repo, second], box, box.root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('repo — ');
    expect(result.stdout).toContain('second — 0 half-done');
  });
});
