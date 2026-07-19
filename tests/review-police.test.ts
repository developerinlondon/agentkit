import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The review gate needs real git state (a branch with a real head sha), so
// these tests build a fixture repo rather than mocking rev-parse.

const HOOK = join(import.meta.dir, '..', 'hooks', 'claude', 'review-police.sh');

let repo: string;
let head: string;

function runHook(command: string): string {
  const input = JSON.stringify({ tool_input: { command } });
  const res = spawnSync('bash', [HOOK], { cwd: repo, input, encoding: 'utf-8' });
  return res.stdout ?? '';
}

function record(body: unknown): void {
  mkdirSync(join(repo, '.agentkit', 'reviews'), { recursive: true });
  writeFileSync(join(repo, '.agentkit', 'reviews', 'feat-thing.json'), JSON.stringify(body));
}

const MERGE = 'glab mr merge 12 --squash --yes';

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentkit-review-'));
  execSync('git init -q -b main', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email t@e.com && git config user.name t', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -q --allow-empty -m init', { cwd: repo, stdio: 'pipe' });
  execSync('git checkout -q -b feat/thing', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -q --allow-empty -m work', { cwd: repo, stdio: 'pipe' });
  head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
});

afterAll(() => rmSync(repo, { force: true, recursive: true }));

beforeEach(() => rmSync(join(repo, '.agentkit'), { force: true, recursive: true }));

describe('review-police', () => {
  test('ignores commands that are not merges', () => {
    expect(runHook('glab mr create --title x')).toBe('');
    expect(runHook('git push origin feat/thing')).toBe('');
  });

  test('blocks a merge with no review record', () => {
    const out = runHook(MERGE);
    expect(out).toContain('"deny"');
    expect(out).toContain('no review record');
  });

  test('blocks when the review covers an older commit', () => {
    record({ head_sha: 'deadbeef', verdict: 'pass', findings: [] });
    const out = runHook(MERGE);
    expect(out).toContain('"deny"');
    expect(out).toContain('stale');
  });

  test('blocks on an unresolved HIGH even when the verdict says pass', () => {
    record({
      head_sha: head,
      verdict: 'pass',
      findings: [{ severity: 'HIGH', summary: 'toggle has no backend', resolved: false }],
    });
    const out = runHook(MERGE);
    expect(out).toContain('"deny"');
    expect(out).toContain('toggle has no backend');
  });

  test('blocks on a blocked verdict with no findings listed', () => {
    record({ head_sha: head, verdict: 'blocked', findings: [] });
    expect(runHook(MERGE)).toContain('"deny"');
  });

  test('allows a clean pass for the exact head', () => {
    record({
      head_sha: head,
      verdict: 'pass',
      findings: [{ severity: 'MEDIUM', summary: 'nit', resolved: false }],
    });
    expect(runHook(MERGE)).toBe('');
  });

  test('allows once a blocking finding is resolved', () => {
    record({
      head_sha: head,
      verdict: 'pass',
      findings: [{ severity: 'BLOCKER', summary: 'fixed since', resolved: true }],
    });
    expect(runHook(MERGE)).toBe('');
  });

  test('only user consent unblocks an unresolved BLOCKER', () => {
    const findings = [{ severity: 'BLOCKER', summary: 'ships broken', resolved: false }];
    record({ head_sha: head, verdict: 'blocked', findings });
    expect(runHook(MERGE)).toContain('"deny"');

    record({
      head_sha: head,
      verdict: 'blocked',
      findings,
      user_consent: { granted: true, quote: 'ship it anyway', at: '2026-07-19T00:00:00Z' },
    });
    expect(runHook(MERGE)).toBe('');
  });

  test('consent without the user\'s words does not count', () => {
    record({
      head_sha: head,
      verdict: 'blocked',
      findings: [{ severity: 'HIGH', summary: 'x', resolved: false }],
      user_consent: { granted: true },
    });
    expect(runHook(MERGE)).toContain('"deny"');
  });

  test('gates REST merges too, not just the CLIs', () => {
    for (const cmd of [
      'curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/12/merge',
      'gh pr merge 4 --squash',
      'curl -X PUT https://api.github.com/repos/o/r/pulls/7/merge',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });
});
