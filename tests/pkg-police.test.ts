import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pkgPolice from '../plugins/pkg-police';

const repoRoot = dirname(import.meta.dir);
const hook = join(repoRoot, 'hooks', 'claude', 'pkg-police.sh');
const mockCtx = {
  client: {},
  project: {},
  directory: '/tmp',
  worktree: '/tmp',
  serverUrl: new URL('http://localhost'),
  $: {},
} as any;

function makeInput(command: string) {
  return {
    input: { tool: 'bash', sessionID: 'test', callID: 'test' },
    output: { args: { command } },
  };
}

function runHook(command: string, env: Record<string, string> = {}): string {
  const input = JSON.stringify({ tool_input: { command } });
  return spawnSync('bash', [hook], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, AGENTKIT_ALLOW_PKG: '', ...env },
  }).stdout ?? '';
}

beforeAll(() => {
  // Point the plugin's config lookup at an empty dir so a developer's local
  // pkg-police.enabled=false cannot flip the blocked-case expectations.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pkg-police-test-'));
  delete process.env.AGENTKIT_ALLOW_PKG;
});

describe('Claude pkg-police override', () => {
  test('denies package managers without the override', () => {
    expect(runHook('npm ci')).toContain('"permissionDecision": "deny"');
    expect(runHook('yarn build')).toContain('"permissionDecision": "deny"');
  });

  test('inline AGENTKIT_ALLOW_PKG=1 allows the command', () => {
    expect(runHook('AGENTKIT_ALLOW_PKG=1 npm ci')).not.toContain('deny');
    expect(runHook('AGENTKIT_ALLOW_PKG=1 yarn build')).not.toContain('deny');
  });

  test('environment AGENTKIT_ALLOW_PKG=1 allows the command', () => {
    expect(runHook('npm ci', { AGENTKIT_ALLOW_PKG: '1' })).not.toContain('deny');
  });

  test('unrelated assignments do not unlock the override', () => {
    expect(runHook('AGENTKIT_ALLOW_PKG=10 npm ci')).toContain('"permissionDecision": "deny"');
  });
});

describe('OpenCode pkg-police override', () => {
  test('denies without and allows with the inline override', async () => {
    const hooks = await pkgPolice(mockCtx);
    const blocked = makeInput('npm ci');
    expect(hooks['tool.execute.before']!(blocked.input, blocked.output)).rejects.toThrow('bun');
    const allowed = makeInput('AGENTKIT_ALLOW_PKG=1 npm ci');
    expect(hooks['tool.execute.before']!(allowed.input, allowed.output)).resolves.toBeUndefined();
  });
});
