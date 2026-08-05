import { afterAll, describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Police hooks used to read only Claude snake_case (`tool_input`, `tool_name`).
 * Grok stdin is camelCase (`toolInput`, `toolName`) and uses different tool
 * names. A harness that lists the hooks as loaded but never feeds a shape the
 * scripts understand is fail-open enforcement — this file pins both shapes.
 */
const repoRoot = dirname(import.meta.dir);
const hooksDir = join(repoRoot, 'hooks', 'claude');
const canBound = existsSync('/sys/fs/cgroup/cgroup.controllers');

function runHook(
  script: string,
  payload: unknown,
  env: Record<string, string> = {},
): { stdout: string; status: number | null } {
  const result = spawnSync('bash', [join(hooksDir, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return { stdout: result.stdout ?? '', status: result.status };
}

// resource-police enforces nothing until a config turns it on, so a payload
// test that skipped the config would be asserting the opt-out, not the shape.
const scratch = mkdtempSync('/var/tmp/hook-payload-compat-');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
mkdirSync(join(scratch, 'agentkit'), { recursive: true });
writeFileSync(
  join(scratch, 'agentkit', 'config.yaml'),
  'resource-police:\n  enabled: true\ndelegation-police:\n  enabled: true\n',
);

function isDeny(stdout: string): boolean {
  try {
    const j = JSON.parse(stdout);
    if (j.decision === 'deny') return true;
    if (j.hookSpecificOutput?.permissionDecision === 'deny') return true;
  } catch {
    // non-JSON is not a deny
  }
  return false;
}

function hasDualDenyShape(stdout: string): boolean {
  try {
    const j = JSON.parse(stdout);
    return (
      j.decision === 'deny' &&
      typeof j.reason === 'string' &&
      j.hookSpecificOutput?.permissionDecision === 'deny' &&
      typeof j.hookSpecificOutput?.permissionDecisionReason === 'string'
    );
  } catch {
    return false;
  }
}

describe('hook payload compat (Claude + Grok)', () => {
  const forcePush = 'git push --force origin main';
  const claudeForce = {
    tool_name: 'Bash',
    tool_input: { command: forcePush },
    session_id: 'test-claude',
  };
  const grokForce = {
    toolName: 'run_terminal_command',
    toolInput: { command: forcePush },
    sessionId: 'test-grok',
  };

  test('git-police denies force push on Claude snake_case', () => {
    const { stdout } = runHook('git-police.sh', claudeForce);
    expect(isDeny(stdout)).toBe(true);
    expect(stdout).toContain('Force push');
  });

  test('git-police denies force push on Grok camelCase', () => {
    const { stdout } = runHook('git-police.sh', grokForce);
    expect(isDeny(stdout)).toBe(true);
    expect(stdout).toContain('Force push');
  });

  test('git-police dual-emits Claude and Grok deny shapes', () => {
    const { stdout } = runHook('git-police.sh', grokForce);
    expect(hasDualDenyShape(stdout)).toBe(true);
  });

  test('pkg-police denies npm install on Grok camelCase', () => {
    const { stdout } = runHook('pkg-police.sh', {
      toolName: 'run_terminal_command',
      toolInput: { command: 'npm install lodash' },
    });
    expect(isDeny(stdout)).toBe(true);
    expect(stdout).toMatch(/bun/i);
  });

  // taste-police reads a folder rather than a config, so the fixture is the
  // taste itself: a payload test without one would assert the empty case.
  const tasteRepo = join(scratch, 'taste-repo');
  mkdirSync(join(tasteRepo, '.agentkit', 'tastes'), { recursive: true });
  writeFileSync(
    join(tasteRepo, '.agentkit', 'tastes', 'release-tier.md'),
    [
      '---',
      'name: release-tier',
      'scope: project',
      'strength: require',
      'enforce: block',
      'rule:',
      '  kind: command',
      "  match: 'git tag .*\\bv[0-9]+\\.[0-9]+\\.0\\b'",
      '  remedy: Cut a patch tag.',
      '  override: AGENTKIT_RELEASE_TIER',
      'provenance: 2026-08-05 · session correction',
      '---',
      '',
      'Cut patch releases by default.',
      '',
      'Why: the tier is the owner\'s decision.',
      '',
      'How to apply: propose the patch version.',
      '',
    ].join('\n'),
  );

  test('taste-police denies a blocked command on Claude snake_case', () => {
    const { stdout } = runHook('taste-police.sh', {
      tool_name: 'Bash',
      tool_input: { command: 'git tag v0.8.0' },
      cwd: tasteRepo,
      session_id: 'test-claude',
    });
    expect(isDeny(stdout)).toBe(true);
    expect(stdout).toContain('release-tier');
  });

  test('taste-police denies a blocked command on Grok camelCase', () => {
    const { stdout } = runHook('taste-police.sh', {
      toolName: 'run_terminal_command',
      toolInput: { command: 'git tag v0.8.0' },
      cwd: tasteRepo,
      sessionId: 'test-grok',
    });
    expect(isDeny(stdout)).toBe(true);
    expect(hasDualDenyShape(stdout)).toBe(true);
  });

  test('pages-police denies a raw Pages API write on Grok camelCase', () => {
    const { stdout } = runHook('pages-police.sh', {
      toolName: 'run_terminal_command',
      toolInput: { command: 'curl -X PUT --data @p.html https://pages.agentkit.sbs/api/pages/abc' },
    });
    expect(isDeny(stdout)).toBe(true);
    expect(stdout).toMatch(/publish\.ts/);
  });

  const describeResource = canBound ? describe : describe.skip;
  describeResource('resource-police', () => {
    test('denies unbounded cargo build on Grok camelCase', () => {
      const { stdout } = runHook('resource-police.sh', {
        toolName: 'run_terminal_command',
        toolInput: { command: 'cargo build' },
      }, { XDG_CONFIG_HOME: scratch });
      expect(isDeny(stdout)).toBe(true);
      expect(stdout).toContain('bounded-run');
    });
  });

  test('format-police accepts Grok search_replace tool family (no crash)', () => {
    // Without a dprint config this may exit 0 after a warning; the failure
    // mode we care about is silent no-op on tool name — family must pass the
    // gate so the path extractor runs (empty path still exits 0).
    const { status } = runHook('format-police.sh', {
      toolName: 'search_replace',
      toolInput: { file_path: '/tmp/agentkit-format-probe.ts' },
    });
    expect(status).toBe(0);
  });

  test('coding-police accepts Grok write tool family', () => {
    const { status, stdout } = runHook('coding-police.sh', {
      toolName: 'write',
      toolInput: { file_path: '/tmp/agentkit-coding-probe.ts', content: 'const x = 1\n' },
    });
    // May warn or pass; must not die on unknown tool family.
    expect(status).toBe(0);
    expect(stdout).not.toMatch(/permissionDecision":"deny"/);
  });

  test('review-police treats run_terminal_command as Bash family (not MCP exit)', () => {
    // Non-merge bash should fall through without MCP deny.
    const { stdout, status } = runHook('review-police.sh', {
      toolName: 'run_terminal_command',
      toolInput: { command: 'echo hello' },
      sessionId: 'test-review',
    });
    expect(status).toBe(0);
    expect(isDeny(stdout)).toBe(false);
  });
});
