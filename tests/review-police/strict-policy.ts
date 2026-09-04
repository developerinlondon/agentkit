import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY, REPOSITORY_ID, SOURCE_BRANCH } from './constants';
import { repo, setSourceSha, setTargetSha, sourceSha, targetSha, writeFakeForge } from './fixture';

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

const strictAnalysisKinds = [
  'claims_audit',
  'falsification',
  'failure_trace',
  'analogy_differences',
  'pattern_sweep',
  'new_assumptions',
  'artifact_lifetime',
];

export function strictTier(critical = false, allowLocalConsent = false): object {
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

export const strictPolicy = {
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

export function enableTargetPolicy(body: unknown = strictPolicy): void {
  mkdirSync(join(repo, '.agentkit'), { recursive: true });
  const rendered = typeof body === 'string' ? body : JSON.stringify(body);
  writeFileSync(join(repo, '.agentkit', 'review-policy.json'), rendered);
  execSync('git add .agentkit/review-policy.json', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -qm "test: strict target policy"', { cwd: repo, stdio: 'pipe' });
  setTargetSha(execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim());
  writeFakeForge();
}

export function commitSourceChange(policyBody?: unknown): void {
  writeFileSync(join(repo, 'README.md'), `source change ${Date.now()}\n`);
  if (policyBody !== undefined) {
    writeFileSync(join(repo, '.agentkit', 'review-policy.json'), JSON.stringify(policyBody));
  }
  execSync('git add README.md .agentkit/review-policy.json', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -qm "test: source change"', { cwd: repo, stdio: 'pipe' });
  setSourceSha(execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim());
  writeFakeForge();
}

function targetPolicyDigest(): string {
  return execSync(`git rev-parse ${targetSha}:.agentkit/review-policy.json`, {
    cwd: repo,
    encoding: 'utf-8',
  }).trim();
}

export function strictRecord(): StrictReviewFixture {
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
