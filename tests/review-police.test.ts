import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

describe('every police hook parses', () => {
  // A hook with a shell syntax error prints nothing and exits non-zero, which
  // the harness reads as ALLOW — so a typo in ANY of these silently disarms
  // the gate it implements. This happened for real: an embedded python block
  // quoted with "'"'" sequences terminated the shell string early, and the
  // whole hook stopped running while the suite still passed.
  const hookDir = join(import.meta.dir, '..', 'hooks', 'claude');
  for (const name of readdirSync(hookDir).filter((f) => f.endsWith('.sh'))) {
    test(`${name} is syntactically valid bash`, () => {
      const res = spawnSync('bash', ['-n', join(hookDir, name)], { encoding: 'utf-8' });
      expect(res.stderr, `${name}: ${res.stderr}`).toBe('');
      expect(res.status).toBe(0);
    });
  }
});

describe('review-police: evasion probe table', () => {
  // Cases live in tests/probe-cases.txt (tab-separated EXPECT<TAB>command) so
  // the table can be extended without editing code, and so neither this file
  // nor the harness contains a merge-shaped shell command of its own — the
  // gate is installed in this very session and denies those in tool calls.
  const lines = readFileSync(join(import.meta.dir, 'probe-cases.txt'), 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.startsWith('#'));

  test('the probe table is not silently empty', () => {
    expect(lines.length).toBeGreaterThan(10);
  });

  for (const line of lines) {
    const [want, cmd] = line.split('\t');
    test(`${want}: ${cmd}`, () => {
      record(passing);
      const out = runHook(cmd);
      if (want === 'DENY') expect(out).toContain('"deny"');
      else expect(out).toBe('');
    });
  }
});

describe('review-police: the hook itself cannot fail open', () => {
  // Every abort path is a fail-open: a hook that dies prints no decision and
  // the harness allows the tool call. These two were reachable from the
  // environment alone.
  function runBare(env: Record<string, string | undefined>): ReturnType<typeof spawnSync> {
    return spawnSync('bash', [HOOK], {
      cwd: repo,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: MERGE },
        session_id: 'test-session',
      }),
      encoding: 'utf-8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...env },
    });
  }

  test('an unset HOME does not abort the gate', () => {
    record(passing);
    // AUDIT="${HOME}/..." tripped `set -u`, exiting 1 with no decision.
    const res = runBare({ HOME: undefined });
    expect(res.stderr).not.toContain('unbound variable');
    expect(res.status).toBe(0);
  });

  test('a missing jq denies rather than dying', () => {
    record(passing);
    const stub = mkdtempSync(join(tmpdir(), 'nojq-'));
    // A PATH with no jq: the hook used to exit 127 on its first parse.
    // bash is invoked by ABSOLUTE path — an empty PATH would otherwise fail to
    // locate bash itself, and the spawn error would masquerade as the hook
    // staying silent (i.e. the test would "pass" for the wrong reason).
    const bash = execSync('command -v bash', { encoding: 'utf-8' }).trim();
    const res = spawnSync(bash, [HOOK], {
      cwd: repo,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: MERGE },
        session_id: 'test-session',
      }),
      encoding: 'utf-8',
      env: { PATH: stub, HOME: home },
    });
    expect(res.stdout).toContain('"deny"');
    expect(res.stdout).toContain('jq');
    rmSync(stub, { force: true, recursive: true });
  });
});

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

  test('a merge URL denies even when only being read', () => {
    record(passing);
    // Deliberate: this used to allow, on the theory that only a recognised HTTP
    // caller counts. That theory WAS the hole — the caller list could never
    // cover every interpreter, so a real merge slipped through as "not a merge".
    // Denying a grep is the cheap failure; missing a merge is the expensive one.
    expect(runHook('grep -rn "merge_requests/999/merge" docs/')).toContain('"deny"');
    expect(runHook('rg "/pulls/999/merge" .')).toContain('"deny"');
  });

  test('a REST merge is gated whatever calls it', () => {
    record(passing);
    // Each of these evaded while the gate required a caller from a fixed list.
    // The python form is not hypothetical: it is how a merge actually reached
    // the forge with no review record.
    const url = 'https://gitlab.com/api/v4/projects/1%2Fp/merge_requests/999/merge';
    for (const cmd of [
      `python3 -c "import urllib.request; urllib.request.urlopen('${url}')"`,
      `node -e "fetch('${url}', {method:'PUT'})"`,
      `ruby -e "Net::HTTP.put(URI('${url}'))"`,
      `perl -e "put('${url}')"`,
      `bun run merge.ts --url '${url}'`,
      // No recognisable client at all — a wrapper script is still a caller.
      `./deploy.sh --endpoint '${url}'`,
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('URL shapes that vary the path do not evade', () => {
    record(passing);
    // Each of these reaches the same endpoint by a slightly different spelling.
    // A gate that matches only the tidiest form is a gate with a door in it.
    for (const cmd of [
      'curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/999/merge/',
      'curl -X PUT "https://gitlab.com/api/v4/projects/1/merge_requests/999/merge?squash=true"',
      'curl -X PUT "https://gitlab.com/api/v4/projects/grp%2Fproj/merge_requests/999/merge"',
      'glab api --method PUT projects/1/merge_requests/999/merge',
      // Assembled at runtime, so no single token carries the whole path.
      'BASE=https://gitlab.com/api/v4/projects/1/merge_requests; curl -X PUT "$BASE/999/merge"',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('ordinary work is not caught by the wider rule', () => {
    record(passing);
    // The trade was "reading a merge URL denies". It was NOT "anything near a
    // merge_requests endpoint denies" — creating or listing must still pass.
    for (const cmd of [
      'curl -X POST https://gitlab.com/api/v4/projects/1/merge_requests -d x',
      'curl https://gitlab.com/api/v4/projects/1/merge_requests?state=opened',
      'git commit -m "feat: add a thing"',
      'git push -u origin feat/thing',
      // Prose naming both halves. Dropping the caller requirement made the
      // split-variable arm fire on any text carrying `merge_requests` and
      // `/merge`, so describing this very rule in a commit message was refused.
      // The arm now needs an INTERPOLATION reaching /merge, which prose has not.
      'git commit -m "docs: describe the merge_requests API and its /merge endpoint"',
      'echo "see docs on merge_requests and /merge for details"',
    ]) {
      expect(runHook(cmd)).toBe('');
    }
  });

  test('a runtime-assembled merge URL is caught however it is assembled', () => {
    record(passing);
    // The split-variable arm exists for these. An earlier narrowing keyed on a
    // `$VAR` interpolation and let five of the six through: command
    // substitution, backticks, `printf -v`, a positional parameter and a string
    // built inside an interpreter all reach the endpoint with no `$name` before
    // /merge. Adjacency is the signal — an assembled path joins something to
    // /merge, English puts a space in front of it.
    const mrs = 'https://gitlab.com/api/v4/projects/1/merge_requests';
    for (const cmd of [
      `BASE=${mrs}; ID=999; curl -X PUT "$BASE/$ID/merge"`,
      `BASE=$(echo ${mrs}); curl -X PUT "$(printf %s "$BASE/999")/merge"`,
      `curl -X PUT "\`echo ${mrs}/999\`/merge"`,
      `A=(${mrs}); curl -X PUT "\${A[0]}/999/merge"`,
      `printf -v U "%s/999/merge" "${mrs}"; curl -X PUT "$U"`,
      `set -- ${mrs}; curl -X PUT "$1/999/merge"`,
      `python3 -c "b='${mrs}'; put(b+'/999/merge')"`,
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('a heredoc-fed interpreter is gated too', () => {
    record(passing);
    // The exact shape that got through: the URL lives inside a heredoc body,
    // and nothing on the command line looks like an HTTP client.
    const cmd = [
      "python3 - <<'PY'",
      'import urllib.request',
      'urllib.request.urlopen("https://gitlab.com/api/v4/projects/1/merge_requests/999/merge")',
      'PY',
    ].join('\n');
    expect(runHook(cmd)).toContain('"deny"');
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

  test('a shell-wrapped merge is still a merge, in every calling convention', () => {
    record(passing);
    // Tokenising treats quoted text as data — correct, EXCEPT when a shell is
    // handed it to execute. These collapsed to one inert token and failed open.
    // The first attempt at this recognised only `<bare shell> -c <script>`, and
    // every form below EXCEPT that one still evaded it. Enumerating shell
    // calling conventions is a losing game, which is why the rule is now
    // "a shell is mentioned ⇒ expand every token".
    for (const cmd of [
      'bash -c "glab mr merge 999"',
      "sh -c 'gh pr merge 999 --squash'",
      'eval "glab mr merge 999"',
      'bash -lc "glab mr merge 999"', // combined flags
      '/bin/bash -c "glab mr merge 999"', // path-qualified interpreter
      'bash -e -u -c "glab mr merge 999"', // extra leading flags
      'sh -euc "gh pr merge 999"',
      'bash -c -- "glab mr merge 999"', // -- separator before the script
      'bash <<< "glab mr merge 999"', // here-string, no -c at all
      'echo "glab mr merge 999" | bash', // piped into a shell
      'env bash -c "glab mr merge 999"',
      'timeout 5 bash -c "glab mr merge 999"',
    ]) {
      expect(runHook(cmd), cmd).toContain('"deny"');
    }
  });

  test('nesting deeper than the expansion bound does not become a hole', () => {
    record(passing);
    // The bound existed to stop runaway recursion, but returning the level's
    // tokens unexpanded at the cap made nest-5 ALLOW. Exhausting the bound now
    // falls back to whitespace splitting, which over-matches.
    let cmd = 'glab mr merge 999';
    for (let i = 0; i < 8; i++) {
      cmd = `bash -c ${JSON.stringify(cmd)}`;
      expect(runHook(cmd), `nest ${i + 1}`).toContain('"deny"');
    }
  });

  test('a shell-wrapped merge is caught even without python3', () => {
    record(passing);
    // The tokeniser needs python3; without it the hook splits on whitespace.
    // That left quotes glued to the first word (`"glab`), so exact-token
    // matching missed and the merge was ALLOWED — a fail-open on a machine
    // that merely lacks python3.
    const stub = join(bin, '..', 'stub');
    mkdirSync(stub, { recursive: true });
    const p = join(stub, 'python3');
    writeFileSync(p, '#!/bin/sh\nexit 127\n');
    chmodSync(p, 0o755);
    const res = spawnSync('bash', [HOOK], {
      cwd: repo,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'bash -c "glab mr merge 999"' },
        session_id: 'test-session',
      }),
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${stub}:${bin}:${process.env.PATH}`, HOME: home },
    });
    expect(res.stdout ?? '').toContain('"deny"');
  });

  test('every push option is scanned, not just the first', () => {
    record(passing);
    // The idiomatic GitLab form passes several -o flags. Reading only the
    // token after the FIRST one let the merge option through.
    for (const cmd of [
      'git push -o ci.skip -o merge_request.merge_when_pipeline_succeeds origin b',
      'git push -o merge_request.target_branch=main -o merge_request.merge_when_pipeline_succeeds origin b',
      'git push --push-option merge_request.merge_when_pipeline_succeeds origin b',
      'git push -o "merge_request.merge_when_pipeline_succeeds" origin b',
      "git push -o 'merge_request.merge_when_pipeline_succeeds' origin b",
      'git push --push-option="merge_request.merge_when_pipeline_succeeds" origin b',
    ]) {
      expect(runHook(cmd), cmd).toContain('"deny"');
    }
  });

  test('a flag AFTER merge does not lose the MR id', () => {
    record(passing);
    // Fails closed rather than open, but it denies an honest merge with a
    // reason that misdiagnoses the cause.
    expect(runHook('gh pr merge --squash 12')).toBe('');
    expect(runHook('glab mr merge --yes 12')).toBe('');
    // The allow-cases alone cannot catch a broken extraction: an unresolvable
    // id makes the fake forge fall back to MR 12's branch, so they pass either
    // way. These pin that the id READ is the id GIVEN — a different MR must
    // still be denied when a flag sits between the verb and the number.
    expect(runHook('gh pr merge --squash 999')).toContain('"deny"');
    expect(runHook('glab mr merge --yes 999')).toContain('"deny"');
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
