import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const productionRunner = join(repoRoot, 'tools', 'agentkit-run');

let root: string;
let binDir: string;
let homeDir: string;
let procRoot: string;
let runner: string;
let runtimeRoot: string;
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
  const fixture = join(root, `proc-${crypto.randomUUID()}`);
  mkdirSync(join(fixture, 'pressure'), { recursive: true });
  writeFileSync(
    join(fixture, 'meminfo'),
    `MemTotal:       131072000 kB\nMemAvailable:   ${options.availableKiB ?? 67108864} kB\n`,
  );
  writeFileSync(join(fixture, 'loadavg'), '0.25 0.50 0.75 1/100 123\n');
  writeFileSync(
    join(fixture, 'pressure', 'memory'),
    `some avg10=${options.some ?? 0}.00 avg60=0.00 avg300=0.00 total=0\n` +
      `full avg10=${options.full ?? 0}.00 avg60=0.00 avg300=0.00 total=0\n`,
  );
  return fixture;
}

function writeTestRunner(fixture = procRoot): void {
  const source = readFileSync(productionRunner, 'utf-8')
    .replace('readonly PROC_ROOT=/proc', `readonly PROC_ROOT=${fixture}`)
    .replace('readonly USER_RUNTIME_ROOT=/run/user', `readonly USER_RUNTIME_ROOT=${runtimeRoot}`)
    .replace('readonly VERIFY_CONTROL_OWNERSHIP=1', 'readonly VERIFY_CONTROL_OWNERSHIP=0')
    .replace('readonly SYSTEMCTL_BIN=/usr/bin/systemctl', `readonly SYSTEMCTL_BIN=${join(binDir, 'systemctl')}`)
    .replace('readonly SYSTEMD_RUN_BIN=/usr/bin/systemd-run', `readonly SYSTEMD_RUN_BIN=${join(binDir, 'systemd-run')}`);
  writeExecutable(runner, source);
}

function runRunner(
  args: string[],
  overrides: Record<string, string> = {},
  fixture = procRoot,
) {
  writeTestRunner(fixture);
  return spawnSync(runner, args, {
    cwd: root,
    encoding: 'utf-8',
    env: runnerEnv(overrides),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-run-'));
  binDir = join(root, 'bin');
  homeDir = join(root, 'home');
  runtimeRoot = join(root, 'run-user');
  runtimeDir = join(runtimeRoot, String(process.getuid?.() ?? 1000));
  runner = join(root, 'agentkit-run');
  systemdLog = join(root, 'systemd-run.args');
  mkdirSync(binDir);
  mkdirSync(homeDir);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'bus'), 'test bus fixture');
  procRoot = writeProcFixture({});

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
MemorySwapMax=\${SHIM_SLICE_MEMORY_SWAP_MAX:-0}
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
if [[ -n "\${SHIM_SYSTEMD_STATUS:-}" ]]; then
  exit "$SHIM_SYSTEMD_STATUS"
fi
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
  test('pins its interpreter and control plane to trusted absolute paths', () => {
    const source = readFileSync(productionRunner, 'utf-8');
    expect(source).toStartWith('#!/bin/bash -p\n');
    for (const path of [
      '/usr/bin/awk',
      '/usr/bin/env',
      '/usr/bin/flock',
      '/usr/bin/getconf',
      '/usr/bin/id',
      '/usr/bin/realpath',
      '/usr/bin/stat',
      '/usr/bin/systemctl',
      '/usr/bin/systemd-run',
      '/usr/bin/timeout',
    ]) {
      expect(source).toContain(path);
    }
    expect(source).not.toContain('AGENTKIT_RUN_TESTING');
    expect(source).not.toContain('AGENTKIT_RUN_PROC_ROOT');
  });

  test('ignores hostile PATH control binaries and BASH_ENV startup code', () => {
    const hostileDir = join(root, 'hostile-bin');
    const pathMarker = join(root, 'hostile-systemd-run-used');
    const bashEnvMarker = join(root, 'bash-env-used');
    const bashEnv = join(root, 'hostile-bash-env');
    mkdirSync(hostileDir);
    writeExecutable(
      join(hostileDir, 'systemd-run'),
      `#!/bin/bash\ntouch "${pathMarker}"\nexec "$@"\n`,
    );
    writeFileSync(bashEnv, `touch "${bashEnvMarker}"\n`);

    writeTestRunner();
    const startup = spawnSync(runner, ['--help'], {
      cwd: root,
      encoding: 'utf-8',
      env: runnerEnv({ BASH_ENV: bashEnv }),
    });
    expect(startup.status, startup.stderr).toBe(0);
    expect(() => readFileSync(bashEnvMarker, 'utf-8')).toThrow();

    const result = runRunner(['--profile', 'canary', '--', '/bin/true'], {
      BASH_ENV: '',
      PATH: `${hostileDir}:${binDir}:/usr/bin:/bin`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(() => readFileSync(pathMarker, 'utf-8')).toThrow();
  });

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
    symlinkSync('/usr/bin/systemd-run', join(binDir, 'alias-systemd-run'));
    for (const command of [
      'docker',
      'podman',
      'systemd-run',
      'alias-systemd-run',
      'sudo',
      'run0',
      'ssh',
    ]) {
      const result = runRunner(['--profile', 'canary', '--', command, 'build', '.']);
      expect(result.status).toBe(64);
      expect(result.stderr).toMatch(/delegates work outside the service cgroup|not allowed/);
    }
    expect(() => readFileSync(systemdLog, 'utf-8')).toThrow();
  });

  test('rejects shell command strings and environment indirection', () => {
    for (const shell of ['fish', 'zsh']) {
      writeExecutable(join(binDir, shell), '#!/bin/bash\nexit 0\n');
    }
    const commands = [
      ['bash', '-lc', 'systemd-run --user cargo test'],
      ['bash', '-xc', 'systemd-run --user cargo test'],
      ['bash', '-cl', 'systemd-run --user cargo test'],
      ['dash', '-ce', 'systemd-run --user cargo test'],
      ['fish', '--command', 'systemd-run --user cargo test'],
      ['zsh', '-ilc', 'systemd-run --user cargo test'],
      ['env', 'CI=1', 'sh', '-c', 'bun test'],
      ['/usr/bin/env', '-i', 'zsh', '-lc', 'cargo test'],
    ];
    for (const command of commands) {
      const result = runRunner(['--profile', 'canary', '--', ...command]);
      expect(result.status).toBe(64);
      expect(result.stderr).toMatch(/shell command strings are not allowed|env is not allowed/);
    }
    expect(() => readFileSync(systemdLog, 'utf-8')).toThrow();
  });

  test('returns 124 when the command timeout expires', () => {
    const result = runRunner(['--profile', 'canary', '--', '/bin/true'], {
      SHIM_SYSTEMD_STATUS: '124',
    });

    expect(result.status).toBe(124);
    const args = readFileSync(systemdLog, 'utf-8');
    expect(args).toContain('--kill-after=10s');
    expect(args).not.toContain('--preserve-status');
  });

  test('does not misreport a workload exit 75 as lock contention', () => {
    const command = join(root, 'fail-with-75');
    writeExecutable(command, '#!/bin/bash\nexit 75\n');

    const result = runRunner(['--profile', 'canary', '--', command]);

    expect(result.status).toBe(75);
    expect(result.stderr).not.toContain('another agentkit-run command is active');
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
      expect(args).toContain('NoNewPrivileges=yes');
      expect(args).toContain('RestrictSUIDSGID=yes');
      expect(args).toContain('MemorySwapMax=0');
      expect(args).toContain('SendSIGKILL=yes');
      expect(args).toContain('TimeoutStopSec=10s');
      expect(args).toContain('Nice=10');
      expect(args).toContain('timeout');
      expect(args).toContain('--kill-after=10s');
      expect(args).toContain('AGENTKIT_RUN_ACTIVE=1');
      expect(args).not.toContain('XDG_RUNTIME_DIR=');
      expect(args).not.toContain('DBUS_SESSION_BUS_ADDRESS=');
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
    const lowMemory = runRunner(['--profile', 'canary', '--', '/bin/true'], {}, lowMemoryProc);
    expect(lowMemory.status).not.toBe(0);
    expect(lowMemory.stderr).toContain('insufficient memory');

    const pressureProc = writeProcFixture({ some: 11, full: 3 });
    const pressure = runRunner(['--profile', 'canary', '--', '/bin/true'], {}, pressureProc);
    expect(pressure.status).not.toBe(0);
    expect(pressure.stderr).toContain('memory pressure is elevated');
  });

  test('allows only one resource-intensive command at a time', async () => {
    const blocker = join(root, 'blocker');
    writeExecutable(blocker, '#!/usr/bin/env bash\nsleep 1\n');
    writeTestRunner();
    const first = spawn(runner, ['--profile', 'canary', '--', blocker], {
      cwd: root,
      env: runnerEnv(),
      stdio: 'ignore',
    });
    await Bun.sleep(150);

    const second = runRunner(['--profile', 'canary', '--', '/bin/true']);

    expect(second.status).toBe(75);
    expect(second.stderr).toContain('failed to get lock');
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
