import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const enabled = process.env.AGENTKIT_RUN_INTEGRATION === '1';
const repoRoot = dirname(import.meta.dir);
const runner = join(repoRoot, 'tools', 'agentkit-run');
const uid = process.getuid?.() ?? 1000;
const sliceRoot = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/agent.slice/agent-work.slice`;
let root: string;

function run(args: string[]) {
  return spawnSync(runner, args, {
    encoding: 'utf-8',
    timeout: 90_000,
    env: process.env,
  });
}

function processExists(pid: number): boolean {
  return spawnSync('/bin/kill', ['-0', String(pid)]).status === 0;
}

function metric(contents: string, name: string): number {
  const line = contents.split('\n').find((entry) => entry.startsWith(`${name} `));
  return Number(line?.split(/\s+/)[1] ?? 0);
}

function runnerUnits(): string[] {
  if (!existsSync(sliceRoot)) return [];
  return readdirSync(sliceRoot).filter((entry) => entry.startsWith('agentkit-run-canary-'));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-run-integration-'));
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(!enabled)('agentkit-run real systemd containment', () => {
  test('applies the canary cgroup, privilege, and environment boundaries', () => {
    const output = join(root, 'cgroup-properties');
    const command = join(root, 'capture-cgroup');
    writeFileSync(
      command,
      `#!/bin/bash
set -euo pipefail
cgroup=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
base="/sys/fs/cgroup$cgroup"
{
  printf 'memory.high=%s\n' "$(<"$base/memory.high")"
  printf 'memory.max=%s\n' "$(<"$base/memory.max")"
  printf 'memory.swap.max=%s\n' "$(<"$base/memory.swap.max")"
  printf 'cpu.max=%s\n' "$(<"$base/cpu.max")"
  printf 'pids.max=%s\n' "$(<"$base/pids.max")"
  awk '/^NoNewPrivs:/ { print "no_new_privileges=" $2 }' /proc/self/status
  printf 'xdg_runtime=%s\n' "\${XDG_RUNTIME_DIR-unset}"
  printf 'dbus=%s\n' "\${DBUS_SESSION_BUS_ADDRESS-unset}"
} > "${output}"
`,
    );
    chmodSync(command, 0o755);

    const result = run(['--profile', 'canary', '--', command]);

    expect(result.status, result.stderr).toBe(0);
    const properties = readFileSync(output, 'utf-8');
    expect(properties).toContain('memory.high=1073741824');
    expect(properties).toContain('memory.max=2147483648');
    expect(properties).toContain('memory.swap.max=0');
    expect(properties).toMatch(/cpu\.max=200000 100000/);
    expect(properties).toContain('pids.max=64');
    expect(properties).toContain('no_new_privileges=1');
    expect(properties).toContain('xdg_runtime=unset');
    expect(properties).toContain('dbus=unset');
  }, 90_000);

  test('propagates workload exit statuses without confusing exit 75 with the lock', () => {
    for (const status of [37, 75]) {
      const command = join(root, `exit-${status}`);
      writeFileSync(command, `#!/bin/bash\nexit ${status}\n`);
      chmodSync(command, 0o755);

      const result = run(['--profile', 'canary', '--', command]);

      expect(result.status).toBe(status);
      expect(result.stderr).not.toContain('failed to get lock');
    }
  }, 90_000);

  test('removes a TERM-resistant descendant when the main workload exits', async () => {
    const pidFile = join(root, 'grandchild.pid');
    const command = join(root, 'descendant-tree');
    writeFileSync(
      command,
      `#!/bin/bash
(trap '' TERM; echo "$BASHPID" > "${pidFile}"; while true; do sleep 1; done) &
while [[ ! -s "${pidFile}" ]]; do sleep 0.01; done
exit 0
`,
    );
    chmodSync(command, 0o755);

    const result = run(['--profile', 'canary', '--', command]);

    expect(result.status).not.toBe(0);
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim());
    for (let attempt = 0; attempt < 100 && processExists(grandchild); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(processExists(grandchild)).toBe(false);
  }, 90_000);

  test('times out a TERM-resistant process tree and removes its descendant', async () => {
    const pidFile = join(root, 'timeout-grandchild.pid');
    const command = join(root, 'timeout-tree');
    writeFileSync(
      command,
      `#!/bin/bash
trap '' TERM
(trap '' TERM; echo "$BASHPID" > "${pidFile}"; while true; do sleep 1; done) &
while true; do sleep 1; done
`,
    );
    chmodSync(command, 0o755);

    const result = run(['--profile', 'canary', '--', command]);

    expect([124, 137]).toContain(result.status);
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim());
    for (let attempt = 0; attempt < 100 && processExists(grandchild); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(processExists(grandchild)).toBe(false);
  }, 90_000);

  test('records a cgroup OOM kill without affecting the caller', async () => {
    const allocator = join(root, 'allocator.py');
    writeFileSync(
      allocator,
      `import mmap
import os

size = 3 * 1024 * 1024 * 1024
descriptor = os.memfd_create("agentkit-oom-fixture")
os.ftruncate(descriptor, size)
memory = mmap.mmap(descriptor, size)
for offset in range(0, size, 4096):
    memory[offset] = 1
`,
    );

    const existingUnits = new Set(runnerUnits());
    const child = Bun.spawn([runner, '--profile', 'canary', '--', 'python3', allocator], {
      env: globalThis.process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    let completed = false;
    const exited = child.exited.then((status) => {
      completed = true;
      return status;
    });
    let unit = '';
    for (let attempt = 0; attempt < 400 && !unit; attempt += 1) {
      unit = runnerUnits().find(
        (entry) => entry.startsWith('agentkit-run-canary-') && !existingUnits.has(entry),
      ) ?? '';
      await Bun.sleep(5);
    }
    expect(unit).not.toBe('');
    const cgroup = join(sliceRoot, unit);
    const releaseSoftThrottle = spawnSync(
      '/usr/bin/systemctl',
      ['--user', 'set-property', '--runtime', unit, 'MemoryHigh=2G'],
      {
        encoding: 'utf-8',
        env: {
          ...globalThis.process.env,
          XDG_RUNTIME_DIR: `/run/user/${uid}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
        },
      },
    );
    expect(releaseSoftThrottle.status, releaseSoftThrottle.stderr).toBe(0);
    let oomKills = 0;
    for (let attempt = 0; attempt < 6_000 && !completed; attempt += 1) {
      const events = join(cgroup, 'memory.events');
      if (existsSync(events)) oomKills = Math.max(oomKills, metric(readFileSync(events, 'utf-8'), 'oom_kill'));
      if (oomKills > 0) break;
      await Bun.sleep(5);
    }
    const status = await exited;
    await new Response(child.stderr).text();

    expect(status).not.toBe(0);
    expect(oomKills).toBeGreaterThan(0);
    expect(processExists(child.pid)).toBe(false);
    expect(globalThis.process.pid).toBeGreaterThan(1);
  }, 90_000);
});
