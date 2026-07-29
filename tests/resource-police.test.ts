import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { enforceResourcePolicy, resourcePolice } from '../plugins/resource-police';
import {
  allowedResourceCommands,
  blockedResourceCommands,
  unsupportedResourceCommands,
  untrustedRunnerCommands,
} from './fixtures/resource-commands';

/**
 * The shell hook enforces only where bounding is possible.
 *
 * `bounded-run` contains work in a systemd scope backed by cgroup v2 and dies
 * without it, so on a host with neither (macOS, most notably) the hook stands
 * down rather than denying every heavy command and naming a remedy that cannot
 * run. These cases assert DENY, so they are Linux-only by construction.
 *
 * Skipped, not deleted, and not silently passing: before this guard existed a
 * macOS checkout reported 64 failures here, which is indistinguishable from a
 * real regression and trains everyone to ignore the suite.
 */
const canBound = existsSync('/sys/fs/cgroup/cgroup.controllers');
const describeShellHook = canBound ? describe : describe.skip;

const repoRoot = dirname(import.meta.dir);
const hook = join(repoRoot, 'hooks', 'claude', 'resource-police.sh');
const policy = join(repoRoot, 'policies', 'codex', 'resource-police.rules');
const delegationPolicy = join(repoRoot, 'policies', 'codex', 'delegation-police.rules');
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

function runHook(command: string, platform?: string): string {
  const input = JSON.stringify({ tool_input: { command } });
  return spawnSync('bash', [hook], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, ...(platform ? { AGENTKIT_PLATFORM: platform } : {}) },
  }).stdout ?? '';
}

const heavyMoonCommands = [
  'moon ci',
  'moon check',
  'moon run agentkit:test-hooks',
  "bash -lc 'moon run agentkit:test-full'",
];

const inspectionMoonCommands = [
  'moon query projects',
  'moon --version',
  'moon config',
  'moon config --json',
];

describe('OpenCode Linux resource policy', () => {
  for (const command of blockedResourceCommands) {
    test(`blocks unbounded command: ${command}`, () => {
      expect(() => enforceResourcePolicy(command, 'linux')).toThrow('bounded-run');
    });
  }

  for (const command of unsupportedResourceCommands) {
    test(`blocks delegated command: ${command}`, () => {
      expect(() => enforceResourcePolicy(command, 'linux')).toThrow(
        'cannot be contained by bounded-run',
      );
    });
  }

  for (const command of untrustedRunnerCommands) {
    test(`refuses an unrecognised runner: ${command}`, () => {
      // This guard had ZERO coverage in the OpenCode implementation: moving
      // the fixture into its own array took it out of the loop above, and
      // deleting the guard outright still left every test passing. Two
      // parallel implementations of one policy need the same cases run
      // against BOTH, or one silently stops enforcing.
      expect(() => enforceResourcePolicy(command, 'linux')).toThrow('not a recognised bounded-run');
    });
  }

  test('allows wrapped, lightweight, and inspection commands', () => {
    for (const command of allowedResourceCommands) {
      expect(() => enforceResourcePolicy(command, 'linux')).not.toThrow();
    }
  });

  test('blocks Moon task execution unless it is contained', () => {
    for (const command of heavyMoonCommands) {
      expect(() => enforceResourcePolicy(command, 'linux')).toThrow('bounded-run');
    }
  });

  test('allows Moon metadata inspection without containment', () => {
    for (const command of inspectionMoonCommands) {
      expect(() => enforceResourcePolicy(command, 'linux')).not.toThrow();
    }
  });

  test('runtime hook follows the host platform while keeping delegation universal', async () => {
    const hooks = await resourcePolice(mockCtx);
    const heavy = makeInput('bun test');
    const delegated = makeInput('docker build .');

    if (process.platform === 'linux') {
      expect(hooks['tool.execute.before']!(heavy.input, heavy.output)).rejects.toThrow('bounded-run');
    } else {
      expect(hooks['tool.execute.before']!(heavy.input, heavy.output)).resolves.toBeUndefined();
    }
    expect(hooks['tool.execute.before']!(delegated.input, delegated.output)).rejects.toThrow(
      'cannot be contained by bounded-run',
    );
  });

  test('ignores non-shell tools', async () => {
    const hooks = await resourcePolice(mockCtx);
    const { input, output } = makeInput('bun run build', 'edit');
    expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
  });
});

describe('platform-aware resource policy', () => {
  test('allows local heavy work when Linux containment is unavailable', () => {
    expect(() => enforceResourcePolicy('bun test', 'darwin')).not.toThrow();
    expect(() =>
      enforceResourcePolicy('./bounded-run --profile default -- bun test', 'darwin'),
    ).not.toThrow();
    expect(runHook('bun test', 'darwin')).not.toContain('deny');
    expect(runHook('./bounded-run --profile default -- bun test', 'darwin')).not.toContain('deny');
  });

  test('blocks delegated work on non-Linux platforms', () => {
    expect(() => enforceResourcePolicy('docker build .', 'darwin')).toThrow(
      'cannot be contained by bounded-run',
    );
    expect(runHook('docker build .', 'darwin')).toContain('cannot be contained by bounded-run');
  });

  test('blocks delegation laundered through nested runners and no-op wrappers', () => {
    const command =
      'bounded-run --profile compile -- command nohup bounded-run --profile compile -- docker build .';
    expect(() => enforceResourcePolicy(command, 'linux')).toThrow(
      'cannot be contained by bounded-run',
    );
    expect(runHook(command, 'linux')).toContain('cannot be contained by bounded-run');
  });

  test('fails closed when runner or wrapper analysis exceeds its bound on every platform', () => {
    const runner = 'bounded-run --profile default -- ';
    const commands = [`${runner.repeat(6)}git status`, `${'command '.repeat(6)}git status`];
    for (const command of commands) {
      for (const platform of ['linux', 'darwin']) {
        expect(() => enforceResourcePolicy(command, platform)).toThrow(
          'could not be analyzed safely',
        );
        expect(runHook(command, platform)).toContain('could not be analyzed safely');
      }
    }
  });
});

describeShellHook('Claude resource-police', () => {
  for (const command of blockedResourceCommands) {
    test(`blocks unbounded command: ${command}`, () => {
      const output = runHook(command);
      expect(output).toContain('"permissionDecision": "deny"');
      expect(output).toContain('bounded-run');
    });
  }

  for (const command of unsupportedResourceCommands) {
    test(`blocks delegated command: ${command}`, () => {
      const output = runHook(command);
      expect(output).toContain('"permissionDecision": "deny"');
      expect(output).toContain('cannot be contained by bounded-run');
    });
  }

  for (const command of untrustedRunnerCommands) {
    test(`refuses an unrecognised runner, and says why: ${command}`, () => {
      const output = runHook(command);
      expect(output).toContain('"permissionDecision": "deny"');
      // The message must name the ACTUAL problem. These were previously
      // refused with the delegated-workload text, which advertises an escape
      // hatch this branch never consults — so a user following the message
      // could not ever unblock, and would reasonably conclude the tool was
      // broken. A gate that misdiagnoses itself wastes the reader's time.
      expect(output).toContain('not a recognised bounded-run');
      expect(output).not.toContain('cannot be contained by bounded-run');
    });

    test(`the delegated escape hatch does NOT clear it: ${command}`, () => {
      // Pins the honesty of the message above: if this ever starts passing
      // the guard, the message must change with it.
      const output = runHook(`AGENTKIT_ALLOW_DELEGATED=1 ${command}`);
      expect(output).toContain('"permissionDecision": "deny"');
    });
  }

  test('allows wrapped, lightweight, and inspection commands', () => {
    for (const command of allowedResourceCommands) {
      expect(runHook(command)).not.toContain('deny');
    }
  });

  test('blocks Moon task execution unless it is contained', () => {
    for (const command of heavyMoonCommands) {
      expect(runHook(command)).toContain('bounded-run');
    }
  });

  test('allows Moon metadata inspection without containment', () => {
    for (const command of inspectionMoonCommands) {
      expect(runHook(command)).not.toContain('deny');
    }
  });
});

describe('Codex resource policies', () => {
  test('separates universal delegation rules from Linux-only containment rules', () => {
    const contents = readFileSync(policy, 'utf-8');
    const delegation = readFileSync(delegationPolicy, 'utf-8');
    const compactDelegation = delegation.replace(/\s+/g, ' ');
    expect(contents).toContain('# agentkit:platforms linux');
    expect(contents).not.toContain('decision = "prompt"');
    expect(delegation).not.toContain('decision = "prompt"');
    expect(contents).toContain('pattern = ["bounded-run"]');
    expect(contents).toContain('pattern = ["agentkit-run"]');
    expect(contents).toContain('decision = "allow"');
    for (const command of ['bun', 'bunx', 'tsc', 'playwright', 'cargo', 'go', 'moon']) {
      expect(contents).toContain(`pattern = ["${command}"`);
    }
    for (const command of [
      'ansible',
      'ansible-playbook',
      'buildah',
      'doas',
      'docker',
      'machinectl',
      'mosh',
      'nerdctl',
      'pkexec',
      'podman',
      'run0',
      'ssh',
      'sudo',
      'systemctl',
      'systemd-run',
      'kubectl',
    ]) {
      expect(contents).not.toContain(`pattern = ["${command}"`);
      expect(delegation).toContain(`pattern = ["${command}"`);
    }
    expect(compactDelegation).toContain('direct command prefixes only');
    expect(compactDelegation).toContain('parse shell payloads');
    expect(contents.match(/decision = "forbidden"/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(contents).toContain('pattern = ["tsc"]');
    expect(contents).toContain('pattern = [["npm", "pnpm"]');
    expect(contents).toContain('pattern = ["yarn"');
    expect(contents).toContain('pattern = ["npx"');
    expect(contents).toContain('pattern = [["pip", "pip3"], "install"]');
    expect(contents).toContain('pattern = ["uv"');
  });

  test('evaluates the direct-command policy matrix when Codex is installed', () => {
    if (spawnSync('codex', ['execpolicy', '--help']).status !== 0) return;

    const resourceDecisions = new Map<string[], string>([
      [['tsc', '-p', 'tsconfig.json'], 'forbidden'],
      [['bunx', 'tsc', '-p', 'tsconfig.json'], 'forbidden'],
      [['bun', 'run', 'typecheck:ci'], 'forbidden'],
      [['npm', 'ci'], 'forbidden'],
      [['pnpm', 'install'], 'forbidden'],
      [['yarn', 'build'], 'forbidden'],
      [['npx', 'tsc', '--noEmit'], 'forbidden'],
      [['pip', 'install', 'requests'], 'forbidden'],
      [['uv', 'sync'], 'forbidden'],
      [['moon', 'ci'], 'forbidden'],
      [['moon', 'check'], 'forbidden'],
      [['moon', 'run', 'agentkit:test-hooks'], 'forbidden'],
      [['moon', 'query', 'projects'], 'allow'],
      [['moon', 'config'], 'allow'],
      [['moon', '--version'], 'allow'],
      [['bounded-run', '--profile', 'compile', '--', 'bun', 'run', 'build'], 'allow'],
      [['agentkit-run', '--profile', 'compile', '--', 'bun', 'run', 'build'], 'allow'],
    ]);

    for (const [command, expected] of resourceDecisions) {
      const result = spawnSync('codex', ['execpolicy', 'check', '--rules', policy, ...command], {
        encoding: 'utf-8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).decision, command.join(' ')).toBe(expected);
    }

    const deniedDelegation = [
      ['ansible', 'all', '-m', 'ping'],
      ['ansible-playbook', 'site.yml'],
      ['buildah', 'bud', '.'],
      ['doas', 'make', 'test'],
      ['docker', 'run', '--rm', 'builder'],
      ['machinectl', 'shell', 'builder'],
      ['mosh', 'build-host'],
      ['nerdctl', 'build', '.'],
      ['pkexec', 'make', 'test'],
      ['podman', 'exec', 'builder', 'bun', 'test'],
      ['run0', 'make', 'test'],
      ['ssh', 'build-host', 'bun', 'test'],
      ['sudo', 'make', 'test'],
      ['systemctl', 'restart', 'build-worker'],
      ['systemctl', '--user', 'restart', 'build-worker'],
      ['systemd-run', '--user', 'cargo', 'test'],
      ['kubectl', 'delete', 'pod', 'builder'],
    ];
    const allowedDiagnostics = [
      ['buildah', 'images'],
      ['docker', 'ps'],
      ['machinectl', 'status', 'builder'],
      ['nerdctl', 'inspect', 'builder'],
      ['podman', 'logs', 'builder'],
      ['systemctl', 'status', 'build-worker'],
      ['systemctl', '--user', 'is-active', 'build-worker'],
      ['kubectl', 'get', 'pods'],
    ];

    for (const command of deniedDelegation) {
      const result = spawnSync(
        'codex',
        ['execpolicy', 'check', '--rules', delegationPolicy, ...command],
        { encoding: 'utf-8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).decision, command.join(' ')).toBe('forbidden');
    }

    for (const command of allowedDiagnostics) {
      const result = spawnSync(
        'codex',
        ['execpolicy', 'check', '--rules', delegationPolicy, ...command],
        { encoding: 'utf-8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).decision, command.join(' ')).toBe('allow');
    }

    const runnerWrappedDelegation = [
      ['bounded-run', '--profile', 'compile', '--', 'docker', 'build', '.'],
      ['agentkit-run', '--profile', 'default', '--', 'systemd-run', '--user', 'cargo', 'test'],
      ['bounded-run', '--profile', 'canary', '--', 'ssh', 'build-host', 'true'],
      ['agentkit-run', '--profile', 'browser', '--', 'kubectl', 'exec', 'pod/builder', '--', 'sh'],
      ['bounded-run', '--', 'docker', 'build', '.'],
      ['agentkit-run', '--', 'ssh', 'build-host', 'true'],
    ];
    for (const command of runnerWrappedDelegation) {
      const result = spawnSync(
        'codex',
        [
          'execpolicy',
          'check',
          '--rules',
          policy,
          '--rules',
          delegationPolicy,
          ...command,
        ],
        { encoding: 'utf-8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).decision, command.join(' ')).toBe('forbidden');
    }

    for (const command of [
      ['bounded-run', '--profile', 'default', '--', 'bun', 'test'],
      ['agentkit-run', '--profile', 'canary', '--', 'git', 'status'],
      ['bounded-run', '--', 'bun', 'test'],
      ['agentkit-run', '--', 'git', 'status'],
    ]) {
      const result = spawnSync(
        'codex',
        [
          'execpolicy',
          'check',
          '--rules',
          policy,
          '--rules',
          delegationPolicy,
          ...command,
        ],
        { encoding: 'utf-8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).decision, command.join(' ')).toBe('allow');
    }

    const wrapped = spawnSync(
      'codex',
      ['execpolicy', 'check', '--rules', delegationPolicy, 'bash', '-lc', 'docker build .'],
      { encoding: 'utf-8' },
    );
    expect(wrapped.status, wrapped.stderr).toBe(0);
    expect(JSON.parse(wrapped.stdout).decision).toBeUndefined();
  }, 30_000);
});
