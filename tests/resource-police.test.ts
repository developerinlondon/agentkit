import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import resourcePolice from '../plugins/resource-police';
import {
  allowedResourceCommands,
  blockedResourceCommands,
  unsupportedResourceCommands,
} from './fixtures/resource-commands';

const repoRoot = dirname(import.meta.dir);
const hook = join(repoRoot, 'hooks', 'claude', 'resource-police.sh');
const policy = join(repoRoot, 'policies', 'codex', 'resource-police.rules');
const mockCtx = {
  client: {},
  project: {},
  directory: '/tmp',
  worktree: '/tmp',
  serverUrl: new URL('http://localhost'),
  $: {},
} as any;

function makeInput(command: string, tool = 'bash') {
  return {
    input: { tool, sessionID: 'test', callID: 'test' },
    output: { args: { command } },
  };
}

function runHook(command: string): string {
  const input = JSON.stringify({ tool_input: { command } });
  return spawnSync('bash', [hook], { input, encoding: 'utf-8' }).stdout ?? '';
}

describe('OpenCode resource-police', () => {
  for (const command of blockedResourceCommands) {
    test(`blocks unbounded command: ${command}`, async () => {
      const hooks = await resourcePolice(mockCtx);
      const { input, output } = makeInput(command);
      expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('agentkit-run');
    });
  }

  for (const command of unsupportedResourceCommands) {
    test(`blocks delegated command: ${command}`, async () => {
      const hooks = await resourcePolice(mockCtx);
      const { input, output } = makeInput(command);
      expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow(
        'cannot be contained by agentkit-run',
      );
    });
  }

  test('allows wrapped, lightweight, and inspection commands', async () => {
    const hooks = await resourcePolice(mockCtx);

    for (const command of allowedResourceCommands) {
      const { input, output } = makeInput(command);
      expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
    }
  });

  test('ignores non-shell tools', async () => {
    const hooks = await resourcePolice(mockCtx);
    const { input, output } = makeInput('bun run build', 'edit');
    expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
  });
});

describe('Claude resource-police', () => {
  for (const command of blockedResourceCommands) {
    test(`blocks unbounded command: ${command}`, () => {
      const output = runHook(command);
      expect(output).toContain('"permissionDecision": "deny"');
      expect(output).toContain('agentkit-run');
    });
  }

  for (const command of unsupportedResourceCommands) {
    test(`blocks delegated command: ${command}`, () => {
      const output = runHook(command);
      expect(output).toContain('"permissionDecision": "deny"');
      expect(output).toContain('cannot be contained by agentkit-run');
    });
  }

  test('allows wrapped, lightweight, and inspection commands', () => {
    for (const command of allowedResourceCommands) {
      expect(runHook(command)).not.toContain('deny');
    }
  });
});

describe('Codex resource policy', () => {
  test('forbids direct heavy command prefixes without interactive prompts', () => {
    const contents = readFileSync(policy, 'utf-8');
    expect(contents).not.toContain('decision = "prompt"');
    expect(contents).toContain('pattern = ["agentkit-run"]');
    expect(contents).toContain('decision = "allow"');
    for (const command of [
      'bun',
      'bunx',
      'tsc',
      'playwright',
      'cargo',
      'go',
      'docker',
      'podman',
      'systemd-run',
    ]) {
      expect(contents).toContain(`pattern = ["${command}"`);
    }
    expect(contents.match(/decision = "forbidden"/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(contents).not.toContain('pattern = ["tsc"],');
    expect(contents).toContain('pattern = ["tsc", ["--noEmit", "-b", "--build"]]');
  });
});
