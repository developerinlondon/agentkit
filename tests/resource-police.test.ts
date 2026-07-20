import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import resourcePolice, {
  containmentAvailable,
  enforceResourcePolicy,
} from '../plugins/resource-police';
import {
  allowedResourceCommands,
  blockedResourceCommands,
  unsupportedResourceCommands,
  untrustedRunnerCommands,
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

// The installer refuses to install bounded-run off Linux. If the policy still
// demanded it there, the agent would be told to install something that will
// never arrive, with no way to proceed.
describe('containment availability', () => {
  test('is Linux-only, matching where bounded-run can actually run', () => {
    expect(containmentAvailable('linux')).toBe(true);
    expect(containmentAvailable('darwin')).toBe(false);
    expect(containmentAvailable('win32')).toBe(false);
  });

  test('blocks on this Linux host, so the guard is not vacuously open', async () => {
    expect(containmentAvailable()).toBe(true);
    const hooks = await resourcePolice(mockCtx);
    const { input, output } = makeInput(blockedResourceCommands[0]!);
    expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('bounded-run');
  });

  // Standing down containment must not stand down the delegation guard: that
  // one exists because the work escapes to a remote Linux target, which is
  // exactly as dangerous from a laptop with no cgroups. Driven at an explicit
  // platform — asserting this through the plugin only ever tests the host's own.
  test('keeps blocking delegated workloads on a platform without containment', () => {
    for (const command of unsupportedResourceCommands) {
      expect(() => enforceResourcePolicy(command, 'darwin')).toThrow(
        'cannot be contained by bounded-run',
      );
    }
  });

  // A wrapper is one token, and nothing stops an agent adding two. Checking the
  // payload once only ever sees one layer down.
  test('sees through runner wrappers hiding a delegated command', () => {
    const laundered = [
      './bounded-run --profile default -- ssh prod-host rm -rf /data',
      '/tmp/evil/bounded-run --profile default -- kubectl delete ns prod',
      './tools/bounded-run --profile default -- sudo systemctl restart nginx',
      'bounded-run --profile default -- bounded-run --profile default -- ssh prod-host rm -rf /data',
      'bounded-run --profile default -- agentkit-run --profile default -- kubectl delete ns prod',
      'bounded-run -- bounded-run -- bounded-run -- ssh prod-host rm -rf /data',
    ];
    for (const command of laundered) {
      for (const platform of ['darwin', 'linux']) {
        expect(() => enforceResourcePolicy(command, platform)).toThrow(
          'cannot be contained by bounded-run',
        );
      }
    }
  });

  // The payload after `--` was read as a launch directly, so it never got the
  // wrapper normalisation a top-level command gets. Generalising over runner
  // NAMES was not enough; the wrapper CLASS has to generalise too.
  test('sees through no-op wrappers inside a runner payload', () => {
    const laundered = [
      'bounded-run --profile default -- nohup ssh prod-host rm -rf /data',
      'bounded-run --profile default -- command ssh prod-host rm -rf /data',
      'bounded-run --profile default -- time ssh prod-host rm -rf /data',
      'bounded-run --profile default -- nohup sudo systemctl restart nginx',
      'bounded-run --profile default -- nohup kubectl delete ns prod',
      'bounded-run -- env agentkit-run -- kubectl delete ns prod',
      'bounded-run -- nohup bounded-run -- ssh prod-host rm -rf /data',
    ];
    for (const command of laundered) {
      for (const platform of ['darwin', 'linux']) {
        expect(() => enforceResourcePolicy(command, platform)).toThrow(
          'cannot be contained by bounded-run',
        );
      }
    }
  });

  // "I stopped analysing" must not become "allowed" once containment stands
  // down. Nesting past the depth limit was the way to say it quietly.
  test('fails closed when a command nests too deeply to analyse', () => {
    const deep = 'sh -c sh -c sh -c sh -c ssh prod-host rm';
    for (const platform of ['darwin', 'linux']) {
      expect(() => enforceResourcePolicy(deep, platform)).toThrow('too deeply to analyse');
    }
  });

  test('does not mistake a wrapped ordinary command for delegation', () => {
    expect(() =>
      enforceResourcePolicy('bounded-run --profile default -- bounded-run -- bun install', 'linux')
    ).not.toThrow();
  });

  // Named explicitly rather than looping blockedResourceCommands: that fixture
  // also carries delegated entries like `sudo -n cargo test`, which must keep
  // blocking off Linux. Only plain local work is let through.
  test('still allows ordinary heavy commands where nothing can bound them', () => {
    for (const command of ['bun install', 'bun run build', 'cargo test']) {
      expect(() => enforceResourcePolicy(command, 'darwin')).not.toThrow();
      expect(() => enforceResourcePolicy(command, 'linux')).toThrow('BLOCKED');
    }
  });

  test('the Claude hook stands down off Linux rather than relying on a crash', () => {
    const source = readFileSync(hook, 'utf-8');
    expect(source).toContain('uname -s');
    const guardAt = source.indexOf('[[ "$(uname -s)" == "Linux" ]] || exit 0');
    expect(guardAt).toBeGreaterThan(-1);
    // It has to stand down before the first hard-coded Linux binary runs.
    expect(guardAt).toBeLessThan(source.indexOf('"$JQ_BIN"'));
  });
});

describe('OpenCode resource-police', () => {
  for (const command of blockedResourceCommands) {
    test(`blocks unbounded command: ${command}`, async () => {
      const hooks = await resourcePolice(mockCtx);
      const { input, output } = makeInput(command);
      expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('bounded-run');
    });
  }

  for (const command of unsupportedResourceCommands) {
    test(`blocks delegated command: ${command}`, async () => {
      const hooks = await resourcePolice(mockCtx);
      const { input, output } = makeInput(command);
      expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow(
        'cannot be contained by bounded-run',
      );
    });
  }

  for (const command of untrustedRunnerCommands) {
    test(`refuses an unrecognised runner: ${command}`, async () => {
      // This guard had ZERO coverage in the OpenCode implementation: moving
      // the fixture into its own array took it out of the loop above, and
      // deleting the guard outright still left every test passing. Two
      // parallel implementations of one policy need the same cases run
      // against BOTH, or one silently stops enforcing.
      const hooks = await resourcePolice(mockCtx);
      const { input, output } = makeInput(command);
      expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow(
        'not a recognised bounded-run',
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
});

describe('Codex resource policy', () => {
  test('forbids direct heavy command prefixes without interactive prompts', () => {
    const contents = readFileSync(policy, 'utf-8');
    expect(contents).not.toContain('decision = "prompt"');
    expect(contents).toContain('pattern = ["bounded-run"]');
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
    expect(contents).toContain('pattern = ["tsc"]');
    expect(contents).toContain('pattern = [["npm", "pnpm"]');
    expect(contents).toContain('pattern = ["yarn"');
    expect(contents).toContain('pattern = ["npx"');
    expect(contents).toContain('pattern = [["pip", "pip3"], "install"]');
    expect(contents).toContain('pattern = ["uv"');
  });

  test('evaluates the direct-command policy matrix when Codex is installed', () => {
    if (spawnSync('codex', ['execpolicy', '--help']).status !== 0) return;

    const decisions = new Map<string[], string>([
      [['tsc', '-p', 'tsconfig.json'], 'forbidden'],
      [['bunx', 'tsc', '-p', 'tsconfig.json'], 'forbidden'],
      [['bun', 'run', 'typecheck:ci'], 'forbidden'],
      [['npm', 'ci'], 'forbidden'],
      [['pnpm', 'install'], 'forbidden'],
      [['yarn', 'build'], 'forbidden'],
      [['npx', 'tsc', '--noEmit'], 'forbidden'],
      [['pip', 'install', 'requests'], 'forbidden'],
      [['uv', 'sync'], 'forbidden'],
      [['docker', 'run', '--rm', 'builder'], 'forbidden'],
      [['ssh', 'build-host', 'bun', 'test'], 'forbidden'],
      [['systemd-run', '--user', 'cargo', 'test'], 'forbidden'],
      [['bounded-run', '--profile', 'compile', '--', 'bun', 'run', 'build'], 'allow'],
      [['agentkit-run', '--profile', 'compile', '--', 'bun', 'run', 'build'], 'allow'],
    ]);

    for (const [command, expected] of decisions) {
      const result = spawnSync('codex', ['execpolicy', 'check', '--rules', policy, ...command], {
        encoding: 'utf-8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).decision, command.join(' ')).toBe(expected);
    }
  });
});
