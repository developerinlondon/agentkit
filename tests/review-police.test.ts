import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The gate resolves the merge target from the FORGE, so the fixture ships a
// fake `glab`/`gh` on PATH. Every bypass the 2026-07-19 review found is a case
// here — the previous suite passed with all of them present, which is how an
// overstated "the agent cannot dismiss this" claim reached review.

const HOOK = join(import.meta.dir, '..', 'hooks', 'claude', 'review-police.sh');

let repo: string;
let bin: string;
let home: string;
const SOURCE_BRANCH = 'feat/thing';
const HEAD = 'a'.repeat(40);

function runHook(command: string, opts: { tool?: string; cwd?: string } = {}): string {
  const input = JSON.stringify({
    tool_name: opts.tool ?? 'Bash',
    tool_input: opts.tool && opts.tool !== 'Bash' ? { pull_number: 12 } : { command },
    session_id: 'test-session',
  });
  const res = spawnSync('bash', [HOOK], {
    cwd: opts.cwd ?? repo,
    input,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home },
  });
  return res.stdout ?? '';
}

/** Fake forge CLI: MR 12 -> feat/thing@HEAD, MR 999 -> other/branch. */
function writeFakeForge(): void {
  const script = `#!/usr/bin/env bash
id=""
for a in "$@"; do [[ "$a" =~ ^[0-9]+$ ]] && id="$a" && break; done
if [[ "$id" == "999" ]]; then
  echo '{"source_branch":"other/branch","sha":"${'b'.repeat(40)}","headRefName":"other/branch","headRefOid":"${'b'.repeat(40)}"}'
else
  echo '{"source_branch":"${SOURCE_BRANCH}","sha":"${HEAD}","headRefName":"${SOURCE_BRANCH}","headRefOid":"${HEAD}"}'
fi
`;
  for (const name of ['glab', 'gh']) {
    const p = join(bin, name);
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
}

function record(body: unknown, slug = 'feat__thing'): void {
  mkdirSync(join(repo, '.agentkit', 'reviews'), { recursive: true });
  writeFileSync(join(repo, '.agentkit', 'reviews', `${slug}.json`), JSON.stringify(body));
}

const passing = { head_sha: HEAD, verdict: 'pass', findings: [] };
const MERGE = 'glab mr merge 12 --squash --yes';

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-review-'));
  repo = join(root, 'repo');
  bin = join(root, 'bin');
  home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: repo, stdio: 'pipe' });
  writeFakeForge();
});

afterAll(() => rmSync(join(repo, '..'), { force: true, recursive: true }));
beforeEach(() => rmSync(join(repo, '.agentkit'), { force: true, recursive: true }));

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

  test('allows a clean pass for the exact head', () => {
    record(passing);
    expect(runHook(MERGE)).toBe('');
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

// Each of these merged cleanly past the first version of this hook.
describe('review-police: bypasses found in adversarial review', () => {
  test('B1: a pass for one branch does not authorise merging a different MR', () => {
    record(passing); // covers feat/thing
    expect(runHook('glab mr merge 999 --squash --yes')).toContain('"deny"');
  });

  // NOTE: this proves the script's behaviour only. That it is REACHED for MCP
  // calls is a registration fact, asserted in tests/agentkit-plugin.test.ts —
  // the first version of this hook refused MCP merges in code that no matcher
  // ever routed to it, and this test passed anyway.
  test('B2: MCP merge tools are refused by the script', () => {
    const out = runHook('', { tool: 'mcp__github__merge_pull_request' });
    expect(out).toContain('"deny"');
    expect(out).toContain('MCP tool');
  });

  test('push options that queue a merge are refused', () => {
    record(passing);
    for (const cmd of [
      'git push -o merge_request.merge_when_pipeline_succeeds origin feat/thing',
      'git push --push-option=merge_request.merge_when_pipeline_succeeds origin feat/thing',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('commands that merely mention the push option are not merges', () => {
    record(passing);
    // `-o` is everywhere, so matching it bare denied ordinary work — including
    // grepping for the very rule this hook enforces. That bit for real: the
    // pre-fix hook blocked the command that was installing its own fix.
    for (const cmd of [
      'grep -o merge_request.merge_when_pipeline_succeeds README.md',
      'rg -o "merge_request.merge" docs/',
      'curl -o merge_request.merge.json https://example.com/x',
      'gcc -o merge_request.merge main.c',
    ]) {
      expect(runHook(cmd)).toBe('');
    }
  });

  test('a push option is caught even behind a flag with its own argument', () => {
    record(passing);
    // `git -C <dir> push` — the guard tolerated flags but not their arguments,
    // the same shape that had already broken MR-id extraction once.
    for (const cmd of [
      'git -C /repo push -o merge_request.merge_when_pipeline_succeeds origin b',
      'git --git-dir=/r/.git push --push-option=merge_request.merge_when_pipeline_succeeds origin b',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('quoted text is not a command: commit messages describing the rules', () => {
    record(passing);
    // This hook blocked the very commits that were fixing it, three times,
    // because the rule it enforces appeared inside a commit message.
    const msg = 'git commit -m "fix: git push -o merge_request.merge_when_pipeline_succeeds is refused"';
    expect(runHook(msg)).toBe('');
    expect(runHook('git commit -m "docs: glab mr merge 12 is gated" && git push')).toBe('');
  });

  test('reading a merge URL is not calling it', () => {
    record(passing);
    // Only an actual HTTP caller counts; grepping or editing the text does not.
    expect(runHook('grep -rn "merge_requests/12/merge" docs/')).toBe('');
    expect(runHook('rg "/pulls/7/merge" .')).toBe('');
  });

  test('creating an MR over REST is not a merge', () => {
    record(passing);
    expect(runHook('curl -X POST https://gitlab.com/api/v4/projects/1/merge_requests -d x')).toBe('');
  });

  test('a flag with its own argument does not lose the MR id', () => {
    record(passing);
    // Detection caught this variant but extraction dropped the id, so it
    // denied an honest merge with "cannot resolve".
    expect(runHook('glab mr --repo group/proj merge 12')).toBe('');
  });

  test('H1: -R / --repo flag variants are still gated', () => {
    record(passing);
    for (const cmd of [
      'glab -R group/proj mr merge 999',
      'gh -R o/r pr merge 999',
      'glab mr --repo group/proj merge 999',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('H2: merging from another directory cannot borrow this repo record', () => {
    record(passing);
    // `cd /tmp && glab mr merge 12` used to ALLOW: the old hook read the local
    // branch, found none, and exited 0. Now the record is looked up in the
    // command's own directory, so it denies — whether because the target can't
    // be resolved or because that directory holds no record for it.
    expect(runHook('cd /tmp && glab mr merge 12', { cwd: '/tmp' })).toContain('"deny"');
  });

  test('H2b: a merge with no MR id cannot be gated, so it is denied', () => {
    record(passing);
    expect(runHook('glab mr merge')).toContain('cannot resolve');
  });

  test('M2: auto-merge is refused — it lands a head no review has seen', () => {
    record(passing);
    expect(runHook('glab mr merge 12 --auto')).toContain('auto-merge');
  });

  test('REST merges are gated, contiguous or split across variables', () => {
    record(passing);
    expect(runHook('curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/999/merge'))
      .toContain('"deny"');
    expect(runHook('gh api --method PUT /repos/o/r/pulls/999/merge')).toContain('"deny"');
  });

  test('QUOTING a merge URL does not evade the gate', () => {
    record(passing);
    // The regression that made quote-STRIPPING the wrong fix: URLs are quoted
    // in every idiomatic REST call, so blanking quoted spans turned these from
    // gated into allowed — a fail-OPEN, the one direction a gate must not fail.
    for (const cmd of [
      'curl -X PUT "https://gitlab.com/api/v4/projects/1/merge_requests/999/merge"',
      "curl -X PUT 'https://gitlab.com/api/v4/projects/1/merge_requests/999/merge'",
      'gh api --method PUT "/repos/o/r/pulls/999/merge"',
    ]) {
      expect(runHook(cmd), cmd).toContain('"deny"');
    }
  });

  test('quoting a CLI merge does not evade the gate either', () => {
    record(passing);
    expect(runHook('glab mr merge "999" --squash --yes')).toContain('"deny"');
    expect(runHook('glab mr merge 999 --repo "group/proj"')).toContain('"deny"');
  });

  test('an unparseable command line still gates the merge', () => {
    record(passing);
    // Unbalanced quotes cannot be tokenised; the fallback splits on whitespace,
    // which over-matches. A merge must never slip through because the line
    // failed to parse.
    expect(runHook('glab mr merge 999 --squash "oops')).toContain('"deny"');
  });
});
