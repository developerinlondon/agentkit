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
const SUPERVISOR = join(import.meta.dir, '..', 'hooks', 'claude', 'fail-closed-hook.sh');

let repo: string;
let bin: string;
let home: string;
let forgeLog: string;
let baseTarget: string;
let targetSha: string;
let githubBaseRefSha: string;
let githubMergeQueue = false;
const SOURCE_BRANCH = 'feat/thing';
const HEAD = 'a'.repeat(40);
let sourceSha = HEAD;
const REPOSITORY = 'https://github.example/owner/repo';
const REPOSITORY_ID = 'gitlab:github.example:1';

type JsonObject = Record<string, unknown>;

interface StrictReviewFixture {
  schema_version: number;
  verdict: string;
  context: JsonObject;
  risk: JsonObject;
  lanes: Record<'diff' | 'product', JsonObject>;
  findings: JsonObject[];
  claims: JsonObject[];
  checks: JsonObject[];
  analyses: JsonObject[];
  evidence_ref: string;
}

const HOOK_TIMEOUT_MS = 15_000;

// review-police.sh exits 0 on every path — allow (empty stdout), deny (a JSON
// decision), even its own missing-jq fallback. A non-zero exit, a kill signal,
// or a spawn error (which covers a timeout) therefore never means "allow": it
// means the gate never actually answered, which an empty string cannot be
// told apart from otherwise. Returns null when the process answered normally.
function hookDidNotAnswer(res: ReturnType<typeof spawnSync>): string | null {
  if (!res.error && res.status === 0) return null;
  const how = res.error
    ? `spawn failed: ${res.error.message}`
    : `exited ${res.status ?? 'null'}${res.signal ? ` (signal ${res.signal})` : ''}`;
  const stderrTail = (res.stderr ?? '').toString().trim().split('\n').slice(-10).join('\n');
  return `review-police.sh did not answer — ${how}${stderrTail ? `\nstderr:\n${stderrTail}` : ''}`;
}

function runHook(
  command: string,
  opts: {
    tool?: string;
    cwd?: string;
    supervised?: boolean;
    toolWorkdir?: string;
    toolWorkdirField?: 'workdir' | 'cwd';
    camelToolInput?: boolean;
    payloadCwd?: string;
    hookPath?: string;
  } = {},
): string {
  const toolInput =
    opts.tool && opts.tool !== 'Bash'
      ? { pull_number: 12 }
      : {
          command,
          ...(opts.toolWorkdir === undefined
            ? {}
            : { [opts.toolWorkdirField ?? 'workdir']: opts.toolWorkdir }),
        };
  const input = JSON.stringify({
    ...(opts.camelToolInput
      ? { toolName: opts.tool ?? 'Bash', toolInput, sessionId: 'test-session' }
      : { tool_name: opts.tool ?? 'Bash', tool_input: toolInput, session_id: 'test-session' }),
    ...(opts.payloadCwd === undefined ? {} : { cwd: opts.payloadCwd }),
  });
  const hookPath = opts.hookPath ?? HOOK;
  const args = opts.supervised ? [SUPERVISOR, '5', hookPath] : [hookPath];
  const res = spawnSync('bash', args, {
    cwd: opts.cwd ?? repo,
    input,
    encoding: 'utf-8',
    timeout: HOOK_TIMEOUT_MS,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home },
  });
  const failure = hookDidNotAnswer(res);
  if (failure) throw new Error(failure);
  return res.stdout ?? '';
}

/** Fake forge CLI: MR 12 -> feat/thing@HEAD, MR 999 -> other/branch. */
function writeFakeForge(): void {
  const script = `#!/usr/bin/env bash
args="$*"
printf '%s\\t%s\\n' "\${0##*/}" "$*" >>"${forgeLog}"
if [[ "$1" == "repo" && "$2" == "view" ]]; then
  echo '{"id":"R_fixture","nameWithOwner":"owner/repo","url":"${REPOSITORY}"}'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"/repository/branches/"* ]]; then
  echo '{"commit":{"id":"${targetSha}"}}'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"/rules/branches/"* ]]; then
  echo '${githubMergeQueue ? '[[{"type":"merge_queue"}]]' : '[[]]'}'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"repos/"*"/branches/"* ]]; then
  echo '{"commit":{"sha":"${targetSha}"}}'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"/merge_requests/"*"/diffs"* ]]; then
  echo '[{"new_path":"README.md","old_path":"README.md"}]'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"/pulls/"*"/files"* ]]; then
  echo '[[{"filename":"README.md"}]]'
  exit 0
fi
id=""
for a in "$@"; do [[ "$a" =~ ^[0-9]+$ ]] && id="$a" && break; done
if [[ "$id" == "999" ]]; then
  echo '{"source_branch":"other/branch","sha":"${'b'.repeat(40)}","headRefName":"other/branch","headRefOid":"${'b'.repeat(40)}","target_branch":"main","target_project_id":1,"project_id":1,"web_url":"${REPOSITORY}/-/merge_requests/999","diff_refs":{"base_sha":"${targetSha}","head_sha":"${'b'.repeat(40)}"},"baseRefName":"main","baseRefOid":"${githubBaseRefSha}","url":"${REPOSITORY}/pull/999"}'
else
  echo '{"source_branch":"${SOURCE_BRANCH}","sha":"${sourceSha}","headRefName":"${SOURCE_BRANCH}","headRefOid":"${sourceSha}","target_branch":"main","target_project_id":1,"project_id":1,"web_url":"${REPOSITORY}/-/merge_requests/12","diff_refs":{"base_sha":"${targetSha}","head_sha":"${sourceSha}"},"baseRefName":"main","baseRefOid":"${githubBaseRefSha}","url":"${REPOSITORY}/pull/12"}'
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
const MERGE = `glab mr merge 12 --squash --yes --sha ${HEAD} --auto-merge=false`;
const MERGE_WITH_REPO = `${MERGE} --repo owner/repo`;
const GITHUB_MERGE_WITH_REPO =
  `gh pr merge 12 --squash --delete-branch --match-head-commit ${HEAD} --repo owner/repo`;

function mergeForHead(head: string): string {
  return `glab mr merge 12 --squash --yes --sha ${head} --auto-merge=false`;
}

const strictAnalysisKinds = [
  'claims_audit',
  'falsification',
  'failure_trace',
  'analogy_differences',
  'pattern_sweep',
  'new_assumptions',
  'artifact_lifetime',
];

function strictTier(critical = false, allowLocalConsent = false): object {
  return {
    required_checks: critical ? ['tests'] : [],
    analyses: Object.fromEntries(
      (critical ? strictAnalysisKinds : ['claims_audit']).map((kind) => [
        kind,
        {
          allow_not_applicable:
            critical && !['claims_audit', 'falsification', 'new_assumptions'].includes(kind),
        },
      ]),
    ),
    allowed_product_coverage: critical
      ? ['partial', 'complete']
      : ['none', 'not_applicable', 'partial', 'complete'],
    require_verified_claims: critical,
    allow_unverified_claims: false,
    allow_local_consent: allowLocalConsent,
    require_product_review: critical,
    require_evidence_ref: critical,
  };
}

const strictPolicy = {
  schema_version: 1,
  risk: {
    default_tier: 'standard',
    zones: [
      {
        id: 'review-enforcement',
        tier: 'critical',
        path_regexes: ['^README\\.md$'],
      },
    ],
  },
  checks: {
    tests: { command: 'scripts/product-command default -- bun test' },
  },
  tiers: {
    trivial: strictTier(false, true),
    standard: strictTier(false, true),
    critical: strictTier(true),
  },
};

function enableTargetPolicy(body: unknown = strictPolicy): void {
  mkdirSync(join(repo, '.agentkit'), { recursive: true });
  const rendered = typeof body === 'string' ? body : JSON.stringify(body);
  writeFileSync(join(repo, '.agentkit', 'review-policy.json'), rendered);
  execSync('git add .agentkit/review-policy.json', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -qm "test: strict target policy"', { cwd: repo, stdio: 'pipe' });
  targetSha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
  writeFakeForge();
}

function commitSourceChange(policyBody?: unknown): void {
  writeFileSync(join(repo, 'README.md'), `source change ${Date.now()}\n`);
  if (policyBody !== undefined) {
    writeFileSync(join(repo, '.agentkit', 'review-policy.json'), JSON.stringify(policyBody));
  }
  execSync('git add README.md .agentkit/review-policy.json', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -qm "test: source change"', { cwd: repo, stdio: 'pipe' });
  sourceSha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
  writeFakeForge();
}

function targetPolicyDigest(): string {
  return execSync(`git rev-parse ${targetSha}:.agentkit/review-policy.json`, {
    cwd: repo,
    encoding: 'utf-8',
  }).trim();
}

function strictRecord(): StrictReviewFixture {
  return {
    schema_version: 2,
    verdict: 'pass',
    context: {
      forge: 'gitlab',
      repository: REPOSITORY,
      repository_id: REPOSITORY_ID,
      change_id: 12,
      source_branch: SOURCE_BRANCH,
      target_branch: 'main',
      source_sha: sourceSha,
      target_sha: targetSha,
      policy_digest: targetPolicyDigest(),
    },
    risk: { tier: 'critical', rationale: 'README.md matches the trusted critical zone' },
    lanes: {
      diff: { verdict: 'pass', summary: 'Diff reviewed' },
      product: { verdict: 'pass', coverage: 'partial', summary: 'Product exercised' },
    },
    findings: [],
    claims: [
      {
        lane: 'diff',
        claim: 'The strict hook fixture is bound to the target-owned policy',
        status: 'verified',
        evidence: 'Target-policy integration fixture',
      },
    ],
    checks: [
      {
        id: 'tests',
        command: 'scripts/product-command default -- bun test',
        status: 'pass',
        exit_code: 0,
        output_summary: 'Fixture checks passed',
      },
    ],
    analyses: strictAnalysisKinds.map((kind) =>
      ['failure_trace', 'analogy_differences', 'pattern_sweep', 'artifact_lifetime'].includes(kind)
        ? { kind, status: 'not_applicable', reason: `${kind} does not apply to the fixture` }
        : { kind, status: 'verified', summary: `${kind} checked`, evidence: 'PR comment' },
    ),
    evidence_ref: `${REPOSITORY}/-/merge_requests/12#note_1`,
  };
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-review-'));
  repo = join(root, 'repo');
  bin = join(root, 'bin');
  home = join(root, 'home');
  forgeLog = join(root, 'forge.log');
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email agentkit-tests@example.invalid', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "AgentKit Tests"', { cwd: repo, stdio: 'pipe' });
  execSync('git remote add origin git@github.example:owner/repo.git', {
    cwd: repo,
    stdio: 'pipe',
  });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  execSync('git add README.md', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -qm "test: base target"', { cwd: repo, stdio: 'pipe' });
  baseTarget = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
  targetSha = baseTarget;
  githubBaseRefSha = baseTarget;
  githubMergeQueue = false;
  sourceSha = HEAD;
  writeFakeForge();
});

afterAll(() => rmSync(join(repo, '..'), { force: true, recursive: true }));
beforeEach(() => {
  rmSync(join(repo, '.agentkit'), { force: true, recursive: true });
  rmSync(join(repo, '..', 'duplicate'), { force: true, recursive: true });
  execSync('git remote set-url origin git@github.example:owner/repo.git', {
    cwd: repo,
    stdio: 'pipe',
  });
  execSync(`git reset --hard ${baseTarget}`, { cwd: repo, stdio: 'pipe' });
  targetSha = baseTarget;
  githubBaseRefSha = baseTarget;
  githubMergeQueue = false;
  sourceSha = HEAD;
  writeFileSync(forgeLog, '');
  writeFakeForge();
});

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

describe('review-police: a silent hook is not read as an allow', () => {
  // A hook that exits non-zero with empty stdout used to read as an ALLOW
  // row's expected `''` — the gate never actually answered, and the probe
  // could not tell the difference.
  test('a stub that exits non-zero saying nothing is reported, not swallowed', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'review-police-stub-'));
    const stub = join(stubDir, 'silent-hook.sh');
    writeFileSync(stub, '#!/usr/bin/env bash\nexit 7\n');
    chmodSync(stub, 0o755);
    try {
      expect(() => runHook(MERGE, { hookPath: stub })).toThrow('did not answer');
      expect(() => runHook(MERGE, { hookPath: stub })).toThrow('exited 7');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
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

  test('writes portable UTC audit timestamps with BSD or GNU date', () => {
    const audit = join(home, '.agentkit', 'review-audit.log');
    rmSync(audit, { force: true });
    record(passing);

    const res = runBare({});

    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toBe('');
    expect(readFileSync(audit, 'utf-8')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\tPASS\t.*\tgate_seconds=\d+$/m,
    );
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
    githubMergeQueue = true;
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

describe('review-police: forge host binding', () => {
  test('pins GitHub target APIs to the host resolved from the target repository', () => {
    record(passing);
    expect(
      runHook(`gh pr merge 12 --repo github.example/owner/repo --match-head-commit ${HEAD}`),
    ).toBe('');

    expect(readFileSync(forgeLog, 'utf-8')).toContain(
      'gh\tapi --hostname github.example repos/owner/repo/branches/main',
    );
  });

  test('pins GitLab target APIs to the host resolved from the merge request', () => {
    record(passing);
    expect(
      runHook(
        `glab mr merge 12 --repo github.example/owner/repo --sha ${HEAD} --auto-merge=false`,
      ),
    ).toBe('');

    expect(readFileSync(forgeLog, 'utf-8')).toContain(
      'glab\tapi --hostname github.example projects/1/repository/branches/main',
    );
  });
});

describe('review-police: target-owned strict policy', () => {
  test('allows complete v2 evidence under the exact target policy', () => {
    enableTargetPolicy();
    commitSourceChange();
    record(strictRecord());
    expect(runHook(mergeForHead(sourceSha))).toBe('');
  });

  test('does not let the source checkout weaken the policy judging itself', () => {
    enableTargetPolicy();
    const weakPolicy = {
      ...strictPolicy,
      risk: { ...strictPolicy.risk, zones: [] },
      tiers: {
        ...strictPolicy.tiers,
        standard: strictTier(false, true),
      },
    };
    commitSourceChange(weakPolicy);

    const body = strictRecord();
    body.risk = { tier: 'standard', rationale: 'The source policy calls this standard' };
    body.lanes.product = {
      verdict: 'not_applicable',
      coverage: 'not_applicable',
      summary: 'Not required by the source policy',
    };
    record(body);

    const out = runHook(mergeForHead(sourceSha));
    expect(out).toContain('"deny"');
    expect(out).toContain('minimum risk tier is critical');
  });

  test('fails closed when an existing target policy is malformed', () => {
    enableTargetPolicy('{"schema_version":1,"tiers":');
    record(passing);
    const out = runHook(MERGE);
    expect(out).toContain('"deny"');
    expect(out).toContain('policy');
  });

  test('uses legacy v1 only when policy is absent from the target commit', () => {
    mkdirSync(join(repo, '.agentkit'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'review-policy.json'), JSON.stringify(strictPolicy));
    record(passing);

    expect(runHook(MERGE)).toBe('');
  });

  test('fails closed when the target commit cannot be read', () => {
    targetSha = 'c'.repeat(40);
    writeFakeForge();
    record(passing);

    const out = runHook(MERGE);
    expect(out).toContain('"deny"');
    expect(out).toContain('target commit');
  });

  test('uses the current GitHub branch tip rather than a stale PR baseRefOid', () => {
    githubBaseRefSha = 'd'.repeat(40);
    writeFakeForge();
    record(passing);

    expect(runHook(`gh pr merge 12 --squash --match-head-commit ${HEAD}`)).toBe('');
  });

  test('uses its packaged validator instead of a PATH-shadowed executable', () => {
    enableTargetPolicy();
    commitSourceChange();
    const shadow = join(bin, 'review-gate');
    writeFileSync(shadow, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(shadow, 0o755);
    record({ ...strictRecord(), schema_version: 99 });

    const out = runHook(mergeForHead(sourceSha));
    expect(out).toContain('"deny"');
    expect(out).toContain('record schema');
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
      'git push -omerge_request.merge_when_pipeline_succeeds origin feat/thing',
      'git push --push-option=merge_request.merge_when_pipeline_succeeds origin feat/thing',
      'G=git; $G push -o merge_request.merge_when_pipeline_succeeds origin feat/thing',
    ]) {
      expect(runHook(cmd)).toContain('"deny"');
    }
  });

  test('an assembled forge executable still reaches the standalone-command denial', () => {
    record(passing);
    for (const cmd of [
      'A=g; B=lab; "$A$B" mr merge 12 --yes',
      `part=mr; glab "$part" merge 12 --sha ${HEAD} --auto-merge=false`,
      `group=mr; verb=merge; glab "$group" "$verb" 12 --sha ${HEAD} --auto-merge=false`,
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('standalone forge CLI command');
    }
  });

  test('the supervisor preserves denials for runtime-built merge forms', () => {
    record(passing);
    for (const cmd of [
      'cli=glab; "$cli" mr merge 12 --yes',
      `part=mr; glab "$part" merge 12 --sha ${HEAD} --auto-merge=false`,
      `group=mr; verb=merge; glab "$group" "$verb" 12 --sha ${HEAD} --auto-merge=false`,
      'base=https://api.github.com/repos/o/r/pulls/12; action=merge; curl -X PUT "$base/$action"',
      '/usr/bin/git push -o merge_request.merge_when_pipeline_succeeds origin feat/thing',
      'glab mr merge 12 --auto-merge',
    ]) {
      expect(runHook(cmd, { supervised: true }), cmd).toContain('"deny"');
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

  test('a passing local record cannot authorise an explicit REST target', () => {
    record(passing);
    // REST endpoints carry their own repository identity. Resolving change 12
    // from the current checkout would let an approved local record authorise a
    // different repository that happens to use the same change number.
    for (const cmd of [
      'gh api --method PUT repos/other/repo/pulls/12/merge',
      'glab api --method PUT projects/999/merge_requests/12/merge',
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('direct REST merge');
    }
  });

  test('GraphQL merge mutations cannot hide in file-backed API payloads', () => {
    record(passing);
    const jsonPayload = join(repo, 'merge-payload.json');
    const escapedJsonPayload = join(repo, 'escaped-merge-payload.json');
    const queryPayload = join(repo, 'merge-query.graphql');
    writeFileSync(
      jsonPayload,
      JSON.stringify({
        query: 'mutation { mergePullRequest(input: { pullRequestId: "x" }) { clientMutationId } }',
      }),
    );
    writeFileSync(
      escapedJsonPayload,
      '{"query":"mutation { merge\\u0050ullRequest(input: { pullRequestId: \\"x\\" }) { clientMutationId } }"}\n',
    );
    writeFileSync(
      queryPayload,
      'mutation { mergeRequestAccept(input: { iid: "12" }) { errors } }\n',
    );

    for (const cmd of [
      `gh api graphql --input ${jsonPayload}`,
      `gh api graphql --input=${jsonPayload}`,
      `gh api graphql --input ${escapedJsonPayload}`,
      `gh api graphql -F query=@${queryPayload}`,
      `gh api graphql --field=query=@${queryPayload}`,
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('indirect GraphQL API payload');
    }
  });

  test('opaque stdin-backed GraphQL API payloads fail closed', () => {
    record(passing);
    const jsonPayload = join(repo, 'stdin-merge-payload.json');
    writeFileSync(
      jsonPayload,
      JSON.stringify({
        query: 'mutation { mergePullRequest(input: { pullRequestId: "x" }) { clientMutationId } }',
      }),
    );

    for (const cmd of [
      `gh api graphql --input - < ${jsonPayload}`,
      `gh api graphql --input /dev/stdin < ${jsonPayload}`,
      `cat ${jsonPayload} | gh api graphql --input -`,
      `gh api graphql -F query=@- < ${jsonPayload}`,
      `endpoint=graphql; gh api "$endpoint" --input ${jsonPayload}`,
      `endpoint=graph; suffix=ql; gh api "$endpoint$suffix" --input - < ${jsonPayload}`,
      `field=query=@${jsonPayload}; gh api graphql -F "$field"`,
      `key=query; gh api graphql -F "$key=@${jsonPayload}"`,
      `flag=--input; gh api graphql "$flag" ${jsonPayload}`,
      `flag=--input=${jsonPayload}; gh api graphql "$flag"`,
      `flag=--field=query=@${jsonPayload}; gh api graphql "$flag"`,
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('indirect GraphQL API payload');
    }
  });

  test('file-backed read-only GraphQL requests also fail closed against payload swaps', () => {
    record(passing);
    const jsonPayload = join(repo, 'safe-payload.json');
    const queryPayload = join(repo, 'safe-query.graphql');
    writeFileSync(
      jsonPayload,
      JSON.stringify({ query: 'query { viewer { login } }', variables: {} }),
    );
    writeFileSync(queryPayload, 'query { viewer { login } }\n');

    for (const cmd of [
      `gh api graphql --input ${jsonPayload}`,
      `gh api graphql -F query=@${queryPayload}`,
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('can change after this check');
    }
  });

  test('safe inline GraphQL queries and ordinary API requests remain allowed', () => {
    record(passing);
    for (const cmd of [
      "gh api graphql -f 'query=query { viewer { login } }'",
      "gh api graphql -F 'query=query { viewer { login } }'",
      "gh api graphql -f 'query=query($login:String!){user(login:$login){id}}' -F login=octocat",
      'gh api repos/owner/repo',
    ]) {
      expect(runHook(cmd), cmd).toBe('');
    }
  });

  test('only one standalone literal forge merge can consume a passing record', () => {
    record(passing);
    const nextHead = 'b'.repeat(40);
    for (const cmd of [
      'glab mr merge 12 --yes; glab mr merge 999 --yes',
      `git push origin ${nextHead}:refs/heads/feat/thing && glab mr merge 12 --yes`,
      'bash -c "glab mr merge 12 --yes"',
      'glab mr merge 12 --yes\nglab mr merge 999 --yes',
      'glab mr merge 12 --repo "$(git push origin HEAD:feat/thing && echo owner/repo)"',
      'gh pr merge 12 $MERGE_ARGS',
      'gh pr merge 12 --repo owner/reviewed --repo owner/unreviewed',
      '/usr/local/bin/gh pr merge 12 --squash',
      'glab mr accept 12 --yes',
    ]) {
      const out = runHook(cmd);
      expect(out, cmd).toContain('"deny"');
      expect(out, cmd).toContain('standalone forge CLI command');
    }
  });

  test('a path-qualified forge CLI does not evade merge detection', () => {
    record(passing);
    expect(runHook('/usr/local/bin/glab mr merge 999 --yes')).toContain('"deny"');
    expect(runHook('/usr/local/bin/gh pr merge 999 --squash')).toContain('"deny"');
  });

  test('a numeric flag value cannot be mistaken for the change id', () => {
    record({ head_sha: 'b'.repeat(40), verdict: 'pass', findings: [] }, 'other__branch');
    const out = runHook('gh pr merge --body 999 12 --squash');
    expect(out).toContain('"deny"');
    expect(out).toContain('standalone forge CLI command');
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

  test('repository selectors after the literal change id remain bindable', () => {
    record(passing);
    expect(
      runHook(`glab mr merge 12 --repo group/proj --sha ${HEAD} --auto-merge=false`),
    ).toBe('');
    expect(runHook(`gh pr merge 12 --repo owner/repo --match-head-commit ${HEAD}`)).toBe('');
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

  test('H2b: a merge with no MR id is not a canonical command, so it is denied', () => {
    record(passing);
    expect(runHook('glab mr merge')).toContain('standalone forge CLI command');
  });

  test('M2: auto-merge is refused — it lands a head no review has seen', () => {
    record(passing);
    expect(runHook('glab mr merge 12 --auto')).toContain('auto-merge');
    expect(runHook('glab mr merge 12 --auto-merge')).toContain('auto-merge');
    for (const flag of ['--auto=true', '--auto=TRUE', '--auto=1']) {
      expect(runHook(`gh pr merge 12 ${flag} --match-head-commit ${HEAD}`)).toContain(
        'auto-merge',
      );
    }
  });

  test('REST merges are gated, contiguous or split across variables', () => {
    record(passing);
    expect(runHook('curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/999/merge'))
      .toContain('"deny"');
    expect(runHook('gh api --method PUT /repos/o/r/pulls/999/merge')).toContain('"deny"');
    expect(
      runHook(
        'base=https://api.github.com/repos/o/r/pulls/12; action=merge; curl -X PUT "$base/$action"',
      ),
    ).toContain('"deny"');
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

  test('the literal change id precedes merge flags', () => {
    record(passing);
    expect(runHook(`gh pr merge 12 --squash --match-head-commit ${HEAD}`)).toBe('');
    expect(runHook(`glab mr merge 12 --yes --sha ${HEAD} --auto-merge=false`)).toBe('');
    expect(runHook('gh pr merge --squash 12')).toContain('standalone forge CLI command');
    expect(runHook('glab mr merge --yes 12')).toContain('standalone forge CLI command');
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
