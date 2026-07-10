import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const runner = join(repoRoot, 'tools', 'agentkit-run');

let root: string;
let binDir: string;
let homeDir: string;
let runtimeDir: string;
let systemdLog: string;

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function runnerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtimeDir, 'bus')}`,
    SHIM_SYSTEMD_LOG: systemdLog,
    SHIM_SLICE_MEMORY_HIGH: '21474836480',
    SHIM_SLICE_MEMORY_MAX: '25769803776',
    SHIM_SLICE_CPU_QUOTA: '8s',
    SHIM_SLICE_TASKS_MAX: '1536',
    ...overrides,
  };
}

function writeProcFixture(options: { availableKiB?: number; some?: number; full?: number }): string {
  const procRoot = join(root, 'proc');
  mkdirSync(join(procRoot, 'pressure'), { recursive: true });
  writeFileSync(
    join(procRoot, 'meminfo'),
    `MemTotal:       131072000 kB\nMemAvailable:   ${options.availableKiB ?? 67108864} kB\n`,
  );
  writeFileSync(join(procRoot, 'loadavg'), '0.25 0.50 0.75 1/100 123\n');
  writeFileSync(
    join(procRoot, 'pressure', 'memory'),
    `some avg10=${options.some ?? 0}.00 avg60=0.00 avg300=0.00 total=0\n` +
      `full avg10=${options.full ?? 0}.00 avg60=0.00 avg300=0.00 total=0\n`,
  );
  return procRoot;
}

function runRunner(args: string[], overrides: Record<string, string> = {}) {
  return spawnSync('bash', [runner, ...args], {
    cwd: root,
    encoding: 'utf-8',
    env: runnerEnv(overrides),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-run-'));
  binDir = join(root, 'bin');
  homeDir = join(root, 'home');
  runtimeDir = join(root, 'runtime');
  systemdLog = join(root, 'systemd-run.args');
  mkdirSync(binDir);
  mkdirSync(homeDir);
  mkdirSync(runtimeDir);
  writeFileSync(join(runtimeDir, 'bus'), 'test bus fixture');

  writeExecutable(
    join(binDir, 'systemctl'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"show-environment"* ]]; then
  exit "\${SHIM_BUS_STATUS:-0}"
fi
if [[ "$*" == *"show agent-work.slice"* ]]; then
  cat <<EOF
LoadState=loaded
MemoryHigh=\${SHIM_SLICE_MEMORY_HIGH}
MemoryMax=\${SHIM_SLICE_MEMORY_MAX}
CPUQuotaPerSecUSec=\${SHIM_SLICE_CPU_QUOTA}
TasksMax=\${SHIM_SLICE_TASKS_MAX}
EOF
  exit "\${SHIM_SLICE_STATUS:-0}"
fi
exit 1
`,
  );

  writeExecutable(
    join(binDir, 'systemd-run'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$SHIM_SYSTEMD_LOG"
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--" ]]; then
    shift
    exec "$@"
  fi
  shift
done
exit 64
`,
  );
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('agentkit-run argument contract', () => {
  test('requires a known profile and a command after --', () => {
    const missing = runRunner(['--profile', 'compile']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('command after --');

    const unknown = runRunner(['--profile', 'unbounded', '--', '/bin/true']);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("unknown profile 'unbounded'");
    expect(() => readFileSync(systemdLog, 'utf-8')).toThrow();
  });

  test('preserves cwd and argv without evaluating shell syntax', () => {
    const output = join(root, 'command-output');
    const command = join(binDir, 'capture');
    writeExecutable(
      command,
      `#!/usr/bin/env bash
printf '%s\n' "$PWD" > "${output}"
printf '<%s>\n' "$@" >> "${output}"
printf 'secret=<%s>\n' "\${UNSAFE_SECRET:-}" >> "${output}"
`,
    );

    const result = runRunner(
      ['--profile', 'canary', '--', 'capture', 'one two', '$(touch should-not-exist)', '*.md'],
      { UNSAFE_SECRET: 'must-not-cross-boundary' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf-8')).toBe(
      `${root}\n<one two>\n<$(touch should-not-exist)>\n<*.md>\nsecret=<>\n`,
    );
    expect(() => readFileSync(join(root, 'should-not-exist'), 'utf-8')).toThrow();
    expect(readFileSync(systemdLog, 'utf-8')).toContain(`${command}\n`);
  });

  test('returns the command exit status', () => {
    const command = join(root, 'fail-with-37');
    writeExecutable(command, '#!/usr/bin/env bash\nexit 37\n');

    const result = runRunner(['--profile', 'default', '--', command]);

    expect(result.status).toBe(37);
  });

  test('rejects nested agentkit-run instead of deadlocking on its own lock', () => {
    const result = runRunner([
      '--profile',
      'canary',
      '--',
      runner,
      '--profile',
      'canary',
      '--',
      '/bin/true',
    ]);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('nested agentkit-run');
    expect(() => readFileSync(systemdLog, 'utf-8')).toThrow();

    const active = runRunner(['--profile', 'canary', '--', '/bin/true'], {
      AGENTKIT_RUN_ACTIVE: '1',
    });
    expect(active.status).toBe(64);
    expect(active.stderr).toContain('nested agentkit-run');
  });

  test('rejects commands that delegate work outside the service cgroup', () => {
    for (const command of ['docker', 'podman', 'systemd-run']) {
      const result = runRunner(['--profile', 'canary', '--', command, 'build', '.']);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('delegates work outside the service cgroup');
    }
    expect(() => readFileSync(systemdLog, 'utf-8')).toThrow();
  });

  test('rejects shell command strings, including through env', () => {
    const commands = [
      ['bash', '-lc', 'systemd-run --user cargo test'],
      ['env', 'CI=1', 'sh', '-c', 'bun test'],
      ['/usr/bin/env', '-i', 'zsh', '-lc', 'cargo test'],
    ];
    for (const command of commands) {
      const result = runRunner(['--profile', 'canary', '--', ...command]);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('shell command strings are not allowed');
    }
    expect(() => readFileSync(systemdLog, 'utf-8')).toThrow();
  });

  test('returns 124 when the command timeout expires', () => {
    const timeoutLog = join(root, 'timeout.args');
    writeExecutable(
      join(binDir, 'timeout'),
      `#!/usr/bin/env bash
printf '%s\n' "$@" > "${timeoutLog}"
exit 124
`,
    );

    const result = runRunner(['--profile', 'canary', '--', '/bin/true']);

    expect(result.status).toBe(124);
    const args = readFileSync(timeoutLog, 'utf-8');
    expect(args).toContain('--kill-after=10s');
    expect(args).not.toContain('--preserve-status');
  });
});

describe('agentkit-run resource boundary', () => {
  test('maps every profile to explicit systemd cgroup and timeout properties', () => {
    const expected = {
      canary: ['MemoryHigh=1G', 'MemoryMax=2G', 'CPUQuota=200%', 'TasksMax=64', 'RuntimeMaxSec=75s'],
      default: ['MemoryHigh=6G', 'MemoryMax=8G', 'CPUQuota=200%', 'TasksMax=256', 'RuntimeMaxSec=10m15s'],
      compile: ['MemoryHigh=8G', 'MemoryMax=12G', 'CPUQuota=400%', 'TasksMax=512', 'RuntimeMaxSec=15m15s'],
      browser: ['MemoryHigh=12G', 'MemoryMax=16G', 'CPUQuota=400%', 'TasksMax=1024', 'RuntimeMaxSec=20m15s'],
    } as const;

    for (const [profile, properties] of Object.entries(expected)) {
      const result = runRunner(['--profile', profile, '--', '/bin/true']);
      expect(result.status, `${profile}: ${result.stderr}`).toBe(0);
      const args = readFileSync(systemdLog, 'utf-8');
      expect(args).toContain('--user');
      expect(args).toContain('--wait');
      expect(args).toContain('--collect');
      expect(args).toContain('--pipe');
      expect(args).toContain('--expand-environment=no');
      expect(args).toContain('--service-type=exec');
      expect(args).toContain('--slice=agent-work.slice');
      expect(args).toContain('KillMode=control-group');
      expect(args).toContain('OOMPolicy=kill');
      expect(args).toContain('MemorySwapMax=0');
      expect(args).toContain('SendSIGKILL=yes');
      expect(args).toContain('TimeoutStopSec=10s');
      expect(args).toContain('Nice=10');
      expect(args).toContain('timeout');
      expect(args).toContain('--kill-after=10s');
      expect(args).toContain('AGENTKIT_RUN_ACTIVE=1');
      for (const property of properties) expect(args).toContain(property);
    }
  });

  test('fails closed when the user bus or aggregate slice is unavailable or unbounded', () => {
    const noBus = runRunner(['--profile', 'canary', '--', '/bin/true'], {
      SHIM_BUS_STATUS: '1',
    });
    expect(noBus.status).not.toBe(0);
    expect(noBus.stderr).toContain('user systemd manager');

    const unbounded = runRunner(['--profile', 'canary', '--', '/bin/true'], {
      SHIM_SLICE_MEMORY_MAX: 'infinity',
    });
    expect(unbounded.status).not.toBe(0);
    expect(unbounded.stderr).toContain('agent-work.slice');
    expect(unbounded.stderr).toContain('MemoryMax');
  });

  test('refuses low available memory and elevated memory pressure', () => {
    const lowMemoryProc = writeProcFixture({ availableKiB: 32 * 1024 * 1024 });
    const lowMemory = runRunner(['--profile', 'canary', '--', '/bin/true'], {
      AGENTKIT_RUN_TESTING: '1',
      AGENTKIT_RUN_PROC_ROOT: lowMemoryProc,
    });
    expect(lowMemory.status).not.toBe(0);
    expect(lowMemory.stderr).toContain('insufficient memory');

    const pressureProc = writeProcFixture({ some: 11, full: 3 });
    const pressure = runRunner(['--profile', 'canary', '--', '/bin/true'], {
      AGENTKIT_RUN_TESTING: '1',
      AGENTKIT_RUN_PROC_ROOT: pressureProc,
    });
    expect(pressure.status).not.toBe(0);
    expect(pressure.stderr).toContain('memory pressure is elevated');
  });

  test('allows only one resource-intensive command at a time', async () => {
    const blocker = join(root, 'blocker');
    writeExecutable(blocker, '#!/usr/bin/env bash\nsleep 1\n');
    const first = spawn('bash', [runner, '--profile', 'canary', '--', blocker], {
      cwd: root,
      env: runnerEnv(),
      stdio: 'ignore',
    });
    await Bun.sleep(150);

    const second = runRunner(['--profile', 'canary', '--', '/bin/true']);

    expect(second.status).toBe(75);
    expect(second.stderr).toContain('another agentkit-run command is active');
    await new Promise<void>((resolve) => first.once('exit', () => resolve()));
  });

  test('places flock inside the transient service command', () => {
    const result = runRunner(['--profile', 'canary', '--', '/bin/true']);
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(systemdLog, 'utf-8');
    const separator = args.indexOf('--\n');
    const flock = args.indexOf('flock\n');
    expect(flock).toBeGreaterThan(separator);
    expect(args).toContain('--conflict-exit-code=75');
  });
});
