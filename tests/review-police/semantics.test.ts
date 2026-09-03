import { describe, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GITHUB_MERGE_WITH_REPO, MERGE, MERGE_WITH_REPO, passing } from './commands';
import { HEAD, REPOSITORY } from './constants';
import { home, installFixture, record, repo, setGithubMergeQueue, writeFakeForge } from './fixture';
import { runHook, test } from './probe';

installFixture();

describe('review-police: intended semantics', () => {
  test('ignores non-merge commands', () => {
    expect(runHook('glab mr create --title x')).toBe('');
    expect(runHook('git push origin feat/thing')).toBe('');
  });

  test('blocks with no review record', () => {
    expect(runHook(MERGE)).toContain('no review record');
  });

  test('blocks when the review covers an older commit', () => {
    record({ ...passing, head_sha: 'c'.repeat(40) });
    expect(runHook(MERGE)).toContain('does not cover the commit');
  });

  test('blocks an unresolved HIGH even when the verdict says pass', () => {
    record({ ...passing, findings: [{ severity: 'HIGH', summary: 'no backend', resolved: false }] });
    const out = runHook(MERGE);
    expect(out).toContain('"deny"');
    expect(out).toContain('no backend');
  });

  test('a source-side policy file cannot weaken the bootstrap blocking severities', () => {
    record({ ...passing, findings: [{ severity: 'HIGH', summary: 'no backend', resolved: false }] });
    mkdirSync(join(repo, '.agentkit'), { recursive: true });
    writeFileSync(
      join(repo, '.agentkit', 'review-policy.json'),
      JSON.stringify({ gate: { blocking_severities: ['INFO'] } }),
    );
    const out = runHook(MERGE);
    expect(out).toContain('"deny"');
    expect(out).toContain('no backend');
    rmSync(join(repo, '.agentkit', 'review-policy.json'));
  });

  test('allows a clean pass for the exact head', () => {
    record(passing);
    expect(runHook(MERGE)).toBe('');
  });

  for (const [label, options] of [
    ['tool_input.workdir', {}],
    ['tool_input.cwd', { toolWorkdirField: 'cwd' as const }],
    ['toolInput.workdir', { camelToolInput: true }],
    ['toolInput.cwd', { camelToolInput: true, toolWorkdirField: 'cwd' as const }],
  ] as const) {
    test(`uses ${label} when the hook process starts above the repo`, () => {
      record(passing);
      expect(runHook(MERGE, { cwd: join(repo, '..'), toolWorkdir: repo, ...options })).toBe('');
    });
  }

  for (const [forge, command] of [
    ['GitLab', MERGE_WITH_REPO],
    ['GitHub', GITHUB_MERGE_WITH_REPO],
  ] as const) {
    test(`discovers the reviewed ${forge} repo below the Codex session cwd`, () => {
      record(passing);
      const workspace = join(repo, '..');
      expect(
        runHook(command, { cwd: workspace, payloadCwd: workspace, supervised: true }),
      ).toBe('');
    });
  }

  test('ignores a same-branch review record in a repo for another forge remote', () => {
    record(passing);
    const workspace = join(repo, '..');
    const duplicate = join(workspace, 'duplicate');
    mkdirSync(join(duplicate, '.agentkit', 'reviews'), { recursive: true });
    execSync('git init -q -b main', { cwd: duplicate, stdio: 'pipe' });
    execSync('git remote add origin https://github.example/other/repo', {
      cwd: duplicate,
      stdio: 'pipe',
    });
    writeFileSync(
      join(duplicate, '.agentkit', 'reviews', 'feat__thing.json'),
      JSON.stringify(passing),
    );

    expect(runHook(MERGE_WITH_REPO, { cwd: workspace, payloadCwd: workspace })).toBe('');
  });

  for (const [transport, remote] of [
    ['HTTPS', 'https://github.example:8443/owner/repo.git'],
    ['SSH', 'ssh://git@github.example:2222/owner/repo.git'],
  ] as const) {
    test(`does not conflate a non-default ${transport} port with the forge host`, () => {
      record(passing);
      execSync(`git remote set-url origin ${remote}`, { cwd: repo, stdio: 'pipe' });
      const workspace = join(repo, '..');

      expect(runHook(MERGE_WITH_REPO, { cwd: workspace, payloadCwd: workspace })).toContain(
        'uniquely',
      );
    });
  }

  for (const [transport, remote] of [
    ['HTTPS', 'https://github.example:443/owner/repo.git'],
    ['SSH', 'ssh://git@github.example:22/owner/repo.git'],
  ] as const) {
    test(`normalizes the explicit default ${transport} port`, () => {
      record(passing);
      execSync(`git remote set-url origin ${remote}`, { cwd: repo, stdio: 'pipe' });
      const workspace = join(repo, '..');

      expect(runHook(MERGE_WITH_REPO, { cwd: workspace, payloadCwd: workspace })).toBe('');
    });
  }

  test('rejects two reviewed clones of the same forge repo below the session cwd', () => {
    record(passing);
    const workspace = join(repo, '..');
    const duplicate = join(workspace, 'duplicate');
    mkdirSync(join(duplicate, '.agentkit', 'reviews'), { recursive: true });
    execSync('git init -q -b main', { cwd: duplicate, stdio: 'pipe' });
    execSync(`git remote add origin ${REPOSITORY}`, { cwd: duplicate, stdio: 'pipe' });
    writeFileSync(
      join(duplicate, '.agentkit', 'reviews', 'feat__thing.json'),
      JSON.stringify(passing),
    );

    expect(runHook(MERGE_WITH_REPO, { cwd: workspace, payloadCwd: workspace })).toContain(
      'uniquely',
    );
  });

  test('requires an explicit forge repo when the client cwd is only a workspace', () => {
    record(passing);
    const workspace = join(repo, '..');
    expect(runHook(MERGE, { cwd: workspace, payloadCwd: workspace })).toContain(
      'explicit repository',
    );
  });

  test('rejects a relative tool working directory instead of borrowing the hook cwd', () => {
    record(passing);
    expect(runHook(MERGE, { toolWorkdir: '.' })).toContain('working directory');
  });

  test('rejects a tool working directory that is not a Git worktree', () => {
    record(passing);
    expect(runHook(MERGE, { toolWorkdir: home })).toContain('working directory');
  });

  test('accepts case-insensitive legacy pass verdicts', () => {
    record({ ...passing, verdict: 'PASS' });
    expect(runHook(MERGE)).toBe('');
  });

  test('requires the forge merge itself to carry the reviewed head precondition', () => {
    record(passing);
    for (const cmd of [
      'glab mr merge 12 --auto-merge=false --yes',
      `glab mr merge 12 --sha ${'b'.repeat(40)} --auto-merge=false --yes`,
      'gh pr merge 12 --squash',
      `gh pr merge 12 --match-head-commit ${'b'.repeat(40)} --squash`,
    ]) {
      expect(runHook(cmd), cmd).toContain('head precondition');
    }
    expect(runHook(`glab mr merge 12 --sha ${HEAD} --auto-merge=false --yes`)).toBe('');
    expect(runHook(`gh pr merge 12 --match-head-commit=${HEAD} --squash`)).toBe('');
  });

  test('requires current glab to disable its deferred auto-merge default', () => {
    record(passing);
    expect(runHook(`glab mr merge 12 --sha ${HEAD} --yes`)).toContain('auto-merge');
    expect(runHook(`glab mr merge 12 --sha ${HEAD} --auto-merge=true --yes`)).toContain(
      'auto-merge',
    );
    expect(runHook(`glab mr merge 12 --sha ${HEAD} --auto-merge=false --yes`)).toBe('');
  });

  test('refuses implicit GitHub merge-queue deferral', () => {
    record(passing);
    setGithubMergeQueue(true);
    writeFakeForge();

    expect(runHook(`gh pr merge 12 --match-head-commit=${HEAD} --squash`)).toContain(
      'merge queue',
    );
  });

  test('allows once the blocking finding is resolved', () => {
    record({ ...passing, findings: [{ severity: 'BLOCKER', summary: 'fixed', resolved: true }] });
    expect(runHook(MERGE)).toBe('');
  });

  test('only written user consent unblocks', () => {
    const findings = [{ severity: 'BLOCKER', summary: 'ships broken', resolved: false }];
    record({ head_sha: HEAD, verdict: 'blocked', findings });
    expect(runHook(MERGE)).toContain('"deny"');
    record({ head_sha: HEAD, verdict: 'blocked', findings, user_consent: { granted: true } });
    expect(runHook(MERGE)).toContain('"deny"'); // granted without their words is not consent
    record({
      head_sha: HEAD,
      verdict: 'blocked',
      findings,
      user_consent: { granted: true, quote: 'ship it anyway', at: '2026-07-19T00:00:00Z' },
    });
    expect(runHook(MERGE)).toBe('');
  });
});
