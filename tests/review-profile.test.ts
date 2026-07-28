import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = join(import.meta.dir, '..', 'tools', 'review-profile');

let home: string;
let repo: string;

interface Resolution {
  profile: string;
  context: {
    risk: string;
    release: boolean;
    user_facing: boolean;
    target_policy_authoritative: boolean;
    worktree_policy_present: boolean;
  };
  settings: Record<string, string>;
  required: Record<string, boolean>;
}

function resolve(
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [TOOL, '--repo', repo, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      ...env,
    },
  });
}

function output(args: string[] = [], env: Record<string, string | undefined> = {}): Resolution {
  const result = resolve(args, env);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Resolution;
}

function config(path: string, body: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'config.yaml'), body);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentkit-review-profile-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agentkit-review-profile-repo-'));
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
  rmSync(repo, { force: true, recursive: true });
});

describe('review-profile', () => {
  test('documents profiles, task context, and repository selection in help', () => {
    const result = resolve(['--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('fast:');
    expect(result.stderr).toContain('balanced:');
    expect(result.stderr).toContain('strict:');
    expect(result.stderr).toContain('--risk trivial|standard|critical');
    expect(result.stderr).toContain('--release');
    expect(result.stderr).toContain('--user-facing');
    expect(result.stderr).toContain('--repo PATH');
  });

  test('defaults to one exact-head review and reuses exact-SHA CI evidence', () => {
    const result = output(['--risk', 'standard']);

    expect(result.profile).toBe('balanced');
    expect(result.settings).toEqual({
      primary_review: 'nontrivial',
      specialist_review: 'critical',
      product_review: 'triggered',
      ci_evidence: 'reuse',
      local_checks: 'affected',
      evidence_note: 'always',
    });
    expect(result.required).toEqual({
      primary_review: true,
      specialist_review: false,
      product_review: false,
      rerun_ci: false,
      full_local_checks: false,
      evidence_note: true,
    });
  });

  test('activates risk and product lanes from task context', () => {
    const result = output(['--risk', 'critical', '--user-facing']);

    expect(result.context).toMatchObject({ risk: 'critical', user_facing: true });
    expect(result.required.specialist_review).toBe(true);
    expect(result.required.product_review).toBe(true);
  });

  test('applies global and repository overrides after the selected preset', () => {
    config(
      join(home, '.config', 'agentkit'),
      `review:
  profile: fast
  specialist-review: never
  evidence-note: critical
`,
    );
    config(
      join(repo, '.agentkit'),
      `review:
  profile: balanced
  specialist-review: always
  local-checks: full
`,
    );

    const result = output(['--risk', 'standard']);

    expect(result.profile).toBe('balanced');
    expect(result.settings.specialist_review).toBe('always');
    expect(result.settings.local_checks).toBe('full');
    expect(result.settings.evidence_note).toBe('critical');
    expect(result.required.specialist_review).toBe(true);
    expect(result.required.full_local_checks).toBe(true);
    expect(result.required.evidence_note).toBe(false);
  });

  test('lets an explicit profile override config and environment selection', () => {
    config(join(home, '.config', 'agentkit'), 'review:\n  profile: fast\n');

    expect(output([], { AGENTKIT_REVIEW_PROFILE: 'strict' }).profile).toBe('strict');
    expect(
      output(['--profile', 'balanced'], { AGENTKIT_REVIEW_PROFILE: 'strict' }).profile,
    ).toBe('balanced');
  });

  test('reports target policy authority without pretending the profile can lower it', () => {
    mkdirSync(join(repo, '.agentkit'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'review-policy.json'), '{}\n');

    const result = output(['--profile', 'fast', '--risk', 'trivial']);

    expect(result.context.target_policy_authoritative).toBe(true);
    expect(result.context.worktree_policy_present).toBe(true);
    expect(result.required.primary_review).toBe(false);
  });

  test('fails loudly on invalid review configuration', () => {
    config(
      join(home, '.config', 'agentkit'),
      'review:\n  specialist-review: sometimes\n',
    );

    const result = resolve();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('specialist-review');
    expect(result.stderr).toContain('sometimes');
  });

  test('rejects unsupported inline review YAML instead of silently using defaults', () => {
    config(join(home, '.config', 'agentkit'), 'review: { profile: fast }\n');

    const result = resolve();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsupported review section syntax');
  });

  test('records profile activation telemetry without sensitive command data', () => {
    output(['--risk', 'critical', '--release']);

    const audit = readFileSync(join(home, '.agentkit', 'review-audit.log'), 'utf-8');
    expect(audit).toMatch(/\tPROFILE\tprofile=balanced\trisk=critical\t/);
    expect(audit).toContain('release=true');
    expect(audit).toContain('specialist=true');
    expect(audit).not.toContain(repo);
  });
});
