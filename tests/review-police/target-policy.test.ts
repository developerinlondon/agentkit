import { describe, expect } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MERGE, mergeForHead, passing } from './commands';
import { HEAD } from './constants';
import {
  bin,
  installFixture,
  record,
  repo,
  setGithubBaseRefSha,
  setTargetSha,
  sourceSha,
  writeFakeForge,
} from './fixture';
import { runHook, test } from './probe';
import { commitSourceChange, enableTargetPolicy, strictPolicy, strictRecord, strictTier } from './strict-policy';

installFixture();

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
    setTargetSha('c'.repeat(40));
    writeFakeForge();
    record(passing);

    const out = runHook(MERGE);
    expect(out).toContain('"deny"');
    expect(out).toContain('target commit');
  });

  test('uses the current GitHub branch tip rather than a stale PR baseRefOid', () => {
    setGithubBaseRefSha('d'.repeat(40));
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
