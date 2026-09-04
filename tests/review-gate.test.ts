import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATE = join(import.meta.dir, '..', 'tools', 'review-gate');
const SOURCE_SHA = 'a'.repeat(40);
const TARGET_SHA = 'b'.repeat(40);
const CONTEXT = {
  forge: 'github',
  repository: 'https://github.example/owner/repo',
  repository_id: 'github:github.example:R_fixture',
  change_id: 122,
  source_branch: 'feat/evidence-gate',
  target_branch: 'main',
  source_sha: SOURCE_SHA,
  target_sha: TARGET_SHA,
};

type JsonObject = Record<string, unknown>;

interface ReviewFixture {
  schema_version: number;
  verdict: string;
  context: JsonObject;
  risk: JsonObject;
  lanes: Record<'diff' | 'product', JsonObject>;
  findings: JsonObject[];
  claims: JsonObject[];
  checks: JsonObject[];
  analyses: JsonObject[];
  evidence_ref?: string;
  user_consent?: JsonObject;
}

const analysisKinds = [
  'claims_audit',
  'falsification',
  'failure_trace',
  'analogy_differences',
  'pattern_sweep',
  'new_assumptions',
  'artifact_lifetime',
] as const;

function tier(critical = false): object {
  const analyses = Object.fromEntries(
    (critical ? analysisKinds : ['claims_audit', 'falsification']).map((kind) => [
      kind,
      { allow_not_applicable: critical && !['claims_audit', 'falsification', 'new_assumptions'].includes(kind) },
    ]),
  );
  return {
    required_checks: critical ? ['tests'] : [],
    analyses,
    allowed_product_coverage: critical
      ? ['partial', 'complete']
      : ['none', 'not_applicable', 'partial', 'complete'],
    require_verified_claims: critical,
    allow_unverified_claims: false,
    allow_local_consent: !critical,
    require_product_review: critical,
    require_evidence_ref: critical,
  };
}

const policy = {
  schema_version: 1,
  risk: {
    default_tier: 'standard',
    zones: [
      {
        id: 'review-enforcement',
        tier: 'critical',
        path_regexes: ['^(hooks/.*|tools/review-gate|\\.agentkit/review-policy\\.json)$'],
      },
    ],
  },
  checks: {
    tests: { command: 'scripts/product-command default -- bun test' },
  },
  tiers: {
    trivial: tier(),
    standard: tier(),
    critical: tier(true),
  },
};

let root: string;
let repo: string;
let policyPath: string;
let recordPath: string;
let pathsPath: string;
let policyDigest: string;

function verifiedAnalysis(kind: string): JsonObject {
  return {
    kind,
    status: 'verified',
    summary: `${kind} was independently checked`,
    evidence: `PR comment: ${kind}`,
  };
}

function criticalRecord(): ReviewFixture {
  return {
    schema_version: 2,
    verdict: 'pass',
    context: { ...CONTEXT, policy_digest: policyDigest },
    risk: { tier: 'critical', rationale: 'The validator itself is an enforcement path' },
    lanes: {
      diff: {
        verdict: 'pass',
        summary: 'The exact source-head diff survived falsification',
      },
      product: {
        verdict: 'pass',
        coverage: 'partial',
        summary: 'The installed merge workflow was exercised as a user would run it',
      },
    },
    findings: [],
    claims: [
      {
        lane: 'diff',
        claim: 'Strict records are bound to the protected target policy',
        status: 'verified',
        evidence: 'Target-policy integration test',
      },
    ],
    checks: [
      {
        id: 'tests',
        command: 'scripts/product-command default -- bun test',
        status: 'pass',
        exit_code: 0,
        output_summary: 'All tests passed with no skipped failures',
      },
    ],
    analyses: [
      verifiedAnalysis('claims_audit'),
      verifiedAnalysis('falsification'),
      {
        kind: 'failure_trace',
        status: 'not_applicable',
        reason: 'This fixture is not a bug fix',
      },
      {
        kind: 'analogy_differences',
        status: 'not_applicable',
        reason: 'The fixture makes no analogy claim',
      },
      {
        kind: 'pattern_sweep',
        status: 'not_applicable',
        reason: 'The fixture establishes no sibling invariant',
      },
      verifiedAnalysis('new_assumptions'),
      {
        kind: 'artifact_lifetime',
        status: 'not_applicable',
        reason: 'The fixture introduces no durable runtime artifact',
      },
    ],
    evidence_ref: 'https://github.example/owner/repo/pull/122#issuecomment-1',
  };
}

function writeRecord(body: unknown): void {
  writeFileSync(recordPath, JSON.stringify(body));
}

function writePaths(paths: string[]): void {
  writeFileSync(pathsPath, JSON.stringify(paths));
}

function runGate(): ReturnType<typeof spawnSync> {
  return spawnSync(
    'bash',
    [
      GATE,
      '--record',
      recordPath,
      '--policy',
      policyPath,
      '--changed-paths',
      pathsPath,
      '--repository',
      CONTEXT.repository,
      '--repository-id',
      CONTEXT.repository_id,
      '--forge',
      CONTEXT.forge,
      '--change-id',
      String(CONTEXT.change_id),
      '--source-branch',
      CONTEXT.source_branch,
      '--target-branch',
      CONTEXT.target_branch,
      '--source-sha',
      CONTEXT.source_sha,
      '--target-sha',
      CONTEXT.target_sha,
    ],
    { cwd: repo, encoding: 'utf-8' },
  );
}

function output(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-review-gate-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });

  policyPath = join(repo, 'policy.json');
  recordPath = join(repo, 'record.json');
  pathsPath = join(repo, 'paths.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  policyDigest = execFileSync('git', ['hash-object', '--no-filters', policyPath], {
    cwd: repo,
    encoding: 'utf-8',
  }).trim();
  writePaths(['tools/review-gate']);
  writeRecord(criticalRecord());
});

afterEach(() => rmSync(root, { force: true, recursive: true }));

describe('review-gate strict evidence validation', () => {
  test('exposes a successful help path for installed-tool smoke tests', () => {
    const result = spawnSync('bash', [GATE, '--help'], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('usage: review-gate');
  });

  test('accepts a complete critical record bound to the exact change context', () => {
    const result = runGate();
    expect(result.status, output(result)).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stdout).toContain('critical');
  });

  test('accepts AgentKit own committed strict policy', () => {
    writeFileSync(
      policyPath,
      readFileSync(join(import.meta.dir, '..', '.agentkit', 'review-policy.json'), 'utf-8'),
    );
    policyDigest = execFileSync('git', ['hash-object', '--no-filters', policyPath], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    writeRecord(criticalRecord());

    const result = runGate();
    expect(result.status, output(result)).toBe(0);
  });

  test('classifies every review-governance and distribution surface as critical under AgentKit policy', () => {
    writeFileSync(
      policyPath,
      readFileSync(join(import.meta.dir, '..', '.agentkit', 'review-policy.json'), 'utf-8'),
    );
    policyDigest = execFileSync('git', ['hash-object', '--no-filters', policyPath], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();

    for (const path of [
      '.agentkit/config.yaml',
      '.agentkit/product.yaml',
      '.github/workflows/ci.yml',
      '.moon/workspace.yml',
      '.prototools',
      '.claude-plugin/marketplace.json',
      'moon.yml',
      'package.json',
      'bun.lock',
      'plugins-cc/agentkit/.claude-plugin/plugin.json',
      'plugins-cc/agentkit-adversarial-review/tools/review-profile',
      'plugins-cc/agentkit-adversarial-review/hooks/review-police.sh',
      'plugins-cc/agentkit-adversarial-review/skills/adversarial-review/SKILL.md',
      'instructions/evidence-gated-review.md',
      'skills/adversarial-review/SKILL.md',
      'skills/autonomous-workflow/SKILL.md',
      'skills/product-review/SKILL.md',
      'skills/test-driven-development/SKILL.md',
      'instructions/coding-discipline.md',
      'docs/review-process.md',
      'tests/review-gate.test.ts',
      'tests/review-police/semantics.test.ts',
      'tests/review-police/fixture.ts',
      'tests/review-disciplines.test.ts',
      'tests/agentkit-plugin.test.ts',
      'tests/codex-review-hooks.test.ts',
      'tests/hook-supervisor.test.ts',
      'tests/install-claude-plugin.test.ts',
      'tests/install-tools.test.ts',
      'tests/test-slices.test.ts',
      'scripts/check-test-slices.ts',
      'scripts/product-command',
      'tools/review-profile',
      'config.example.yaml',
    ]) {
      writePaths([path]);
      const body = criticalRecord();
      body.risk = { tier: 'standard', rationale: 'Attempted governance downgrade' };
      writeRecord(body);

      const result = runGate();
      expect(result.status, path).not.toBe(0);
      expect(output(result), path).toContain('minimum risk tier is critical');
    }
  });

  test('derives the minimum tier from trusted policy and mechanically enumerated paths', () => {
    const body = criticalRecord();
    body.risk = { tier: 'standard', rationale: 'Self-declared low risk' };
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('minimum risk tier is critical');
  });

  test('rejects replay across every forge and target-policy binding', () => {
    const mutations: Array<[string, (body: ReviewFixture) => void]> = [
      ['forge', (body) => { body.context.forge = 'gitlab'; }],
      ['repository URL', (body) => { body.context.repository = 'https://github.example/other/repo'; }],
      ['repository ID', (body) => { body.context.repository_id = 'github:github.example:R_other'; }],
      ['change ID', (body) => { body.context.change_id = 121; }],
      ['source branch', (body) => { body.context.source_branch = 'feat/other'; }],
      ['target branch', (body) => { body.context.target_branch = 'release'; }],
      ['source SHA', (body) => { body.context.source_sha = 'c'.repeat(40); }],
      ['target SHA', (body) => { body.context.target_sha = 'd'.repeat(40); }],
      ['policy digest', (body) => { body.context.policy_digest = 'e'.repeat(40); }],
    ];

    for (const [binding, mutate] of mutations) {
      const body = criticalRecord();
      mutate(body);
      writeRecord(body);
      const result = runGate();
      expect(result.status, binding).not.toBe(0);
      expect(output(result), binding).toContain('change context');
    }
  });

  test('rejects wrong JSON types instead of defaulting them into a pass', () => {
    const body = criticalRecord();
    body.findings = [
      {
        lane: 'diff',
        severity: 'HIGH',
        summary: 'A real blocker',
        scenario: 'The failing input is replayed',
        resolved: 'false',
      },
    ];
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('record schema');
  });

  test('requires every policy-mandated review lane to pass', () => {
    const body = criticalRecord();
    body.lanes.product = {
      verdict: 'not_applicable',
      coverage: 'not_applicable',
      summary: 'The author says product review is unnecessary',
    };
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("product coverage 'not_applicable' is not allowed");
  });

  test('rejects unverified claims when the selected tier forbids them', () => {
    const body = criticalRecord();
    body.claims.push({
      lane: 'diff',
      claim: 'This probably works',
      status: 'unverified',
      reason: 'No computation or replay was performed',
    });
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('unverified claims');
  });

  test('does not let an empty claims list satisfy a critical claims audit', () => {
    const body = criticalRecord();
    body.claims = [];
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('at least one verified claim');
  });

  test('requires conditional analyses to be explicitly dispositioned', () => {
    const body = criticalRecord();
    body.analyses = body.analyses.filter((entry) => entry.kind !== 'artifact_lifetime');
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("required analysis 'artifact_lifetime'");
  });

  test('does not let local consent override a critical blocking finding', () => {
    const body = criticalRecord();
    body.verdict = 'blocked';
    body.findings = [
      {
        lane: 'diff',
        severity: 'BLOCKER',
        summary: 'The protected policy can be bypassed',
        scenario: 'A permissive source policy replaces the target policy',
        resolved: false,
      },
    ];
    body.user_consent = {
      granted: true,
      quote: 'ship it anyway',
      at: '2026-07-27T12:00:00Z',
    };
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('local consent is disabled');
  });

  test('cross-checks the stored verdict against the evidence-derived verdict', () => {
    const body = criticalRecord();
    body.verdict = 'blocked';
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('derived verdict is pass');
  });

  test('rejects unknown record versions and malformed policies', () => {
    const body = criticalRecord();
    body.schema_version = 99;
    writeRecord(body);
    let result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('record schema');

    writeRecord(criticalRecord());
    writeFileSync(policyPath, JSON.stringify({ ...policy, schema_version: 99 }));
    result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('policy schema');

    writeFileSync(policyPath, '{"schema_version":1,"tiers":');
    result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('policy');
  });

  test('hard-codes the policy file itself as critical even if policy zones omit it', () => {
    const policyWithoutZones = { ...policy, risk: { ...policy.risk, zones: [] } };
    writeFileSync(policyPath, JSON.stringify(policyWithoutZones));
    policyDigest = execFileSync('git', ['hash-object', '--no-filters', policyPath], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    writePaths(['.agentkit/review-policy.json']);
    const body = criticalRecord();
    body.risk = { tier: 'standard', rationale: 'The edited policy removed its own risk zone' };
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('minimum risk tier is critical');
  });

  test('binds deterministic check IDs to their exact trusted commands', () => {
    const body = criticalRecord();
    body.checks[0].command = 'bun test';
    writeRecord(body);

    const result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('command differs from target policy');
  });

  test('rejects empty or malformed changed-path enumerations', () => {
    writePaths([]);
    let result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('changed-path enumeration');

    writeFileSync(pathsPath, '{"path":"tools/review-gate"}');
    result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('changed-path enumeration');
  });

  test('allows a standard record to disposition the optional product lane', () => {
    writePaths(['README.md']);
    const body = criticalRecord();
    body.risk = { tier: 'standard', rationale: 'Documentation outside a critical risk zone' };
    body.lanes.product = {
      verdict: 'not_applicable',
      coverage: 'not_applicable',
      summary: 'The trusted standard-tier policy does not require product review',
    };
    body.checks = [];
    body.analyses = [verifiedAnalysis('claims_audit'), verifiedAnalysis('falsification')];
    delete body.evidence_ref;
    writeRecord(body);

    const result = runGate();
    expect(result.status, output(result)).toBe(0);
    expect(result.stdout).toContain('standard');
  });

  test('keeps unavailable optional product coverage visible without making it required', () => {
    writePaths(['README.md']);
    const body = criticalRecord();
    body.risk = { tier: 'standard', rationale: 'Documentation outside a critical risk zone' };
    body.lanes.product = {
      verdict: 'unable_to_verify',
      coverage: 'none',
      summary: 'The product environment was unavailable',
    };
    body.checks = [];
    body.analyses = [verifiedAnalysis('claims_audit'), verifiedAnalysis('falsification')];
    delete body.evidence_ref;
    writeRecord(body);

    const result = runGate();
    expect(result.status, output(result)).toBe(0);
  });

  test('requires affected tests for standard work and reserves the full suite for critical work', () => {
    const ownPolicy = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '.agentkit', 'review-policy.json'), 'utf-8'),
    );
    writeFileSync(policyPath, JSON.stringify(ownPolicy));
    policyDigest = execFileSync('git', ['hash-object', '--no-filters', policyPath], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    writePaths(['README.md']);

    const body = criticalRecord();
    body.risk = { tier: 'standard', rationale: 'Documentation does not touch a critical zone' };
    body.checks = [
      {
        id: 'affected-tests',
        command: 'scripts/product-command default -- moon ci',
        status: 'pass',
        exit_code: 0,
        output_summary: 'All affected tasks passed',
      },
    ];
    writeRecord(body);

    let result = runGate();
    expect(result.status, output(result)).toBe(0);

    body.checks = criticalRecord().checks;
    writeRecord(body);
    result = runGate();
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("required check 'affected-tests' is missing");
  });
});
