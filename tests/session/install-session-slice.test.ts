import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(import.meta.dir));
const installScript = join(repoRoot, 'install.sh');
const describeLinux = process.platform === 'linux' ? describe : describe.skip;
// A global install intentionally installs and builds dependency-bearing skills.
const globalInstallTimeoutMs = 60_000;
const helperTimeoutMs = 5_000;

function install(home: string, extraArgs: string[] = []) {
  return spawnSync('bash', [installScript, '--global', ...extraArgs], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    encoding: 'utf-8',
    timeout: globalInstallTimeoutMs,
  });
}

function slicePath(home: string) {
  return join(home, '.config', 'systemd', 'user', 'agent-sessions.slice');
}

describeLinux('aggregate Linux session slice', () => {
  test('installs a bounded parent slice for per-session scopes', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-slice-'));
    try {
      const result = install(home);
      expect(result.status, result.stderr).toBe(0);

      const unit = readFileSync(slicePath(home), 'utf-8');
      // Per-session scopes bound one session; without these, N sessions are
      // collectively unbounded, which is the whole point of the slice.
      expect(unit).toContain('[Slice]');
      expect(unit).toMatch(/^MemoryMax=\d+G$/m);
      expect(unit).toMatch(/^MemoryHigh=\d+G$/m);
      expect(unit).toMatch(/^TasksMax=\d+$/m);
      expect(unit).toMatch(/^CPUQuota=\d+%$/m);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('the aggregate ceiling exceeds a single session but stays under host RAM', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-slice-'));
    try {
      install(home);
      const unit = readFileSync(slicePath(home), 'utf-8');
      const aggregate = Number(unit.match(/^MemoryMax=(\d+)G$/m)![1]);

      const shimSource = readFileSync(join(repoRoot, 'tools', 'agent-session'), 'utf-8');
      const perSession = Number(shimSource.match(/^MEMORY_MAX=(\d+)G$/m)![1]);

      expect(aggregate).toBeGreaterThan(perSession);
      // A ceiling at or above host RAM would not bound anything on the box
      // this was sized for (125 GiB, with 88 GiB already committed elsewhere).
      expect(aggregate).toBeLessThan(64);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('re-installing does not clobber an operator drop-in', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-slice-'));
    try {
      install(home);
      const dropInDir = `${slicePath(home)}.d`;
      mkdirSync(dropInDir, { recursive: true });
      writeFileSync(join(dropInDir, '90-local.conf'), '[Slice]\nMemoryMax=8G\n');

      const second = install(home);
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(join(dropInDir, '90-local.conf'), 'utf-8')).toContain('MemoryMax=8G');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, 2 * globalInstallTimeoutMs);

  test('finds the user bus when XDG_RUNTIME_DIR is unset', () => {
    // Terminals spawned by a service manager inherit no XDG_RUNTIME_DIR, so
    // without this the reload defers to next login and the slice is unapplied.
    const home = mkdtempSync(join(tmpdir(), 'agentkit-bus-'));
    try {
      const runtime = join(home, 'run');
      const stubBin = join(home, 'stub');
      mkdirSync(runtime, { recursive: true });
      mkdirSync(stubBin, { recursive: true });
      writeFileSync(join(runtime, 'bus'), '');
      writeFileSync(join(stubBin, 'systemctl'), '#!/bin/bash\nexit 0\n');
      spawnSync('chmod', ['+x', join(stubBin, 'systemctl')], { timeout: helperTimeoutMs });
      spawnSync('chmod', ['+x', join(stubBin, 'id')], { timeout: helperTimeoutMs });

      const probe = (extra: string) =>
        spawnSync('bash', [
          '-c',
          `source <(sed -n '/^user_bus_env()/,/^}/p' '${installScript}')
           export XDG_RUNTIME_DIR='${runtime}'
           ${extra}
           if user_bus_env; then echo "ok:$DBUS_SESSION_BUS_ADDRESS"; else echo no; fi`,
        ], {
          encoding: 'utf-8',
          env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
          timeout: helperTimeoutMs,
        });

      expect(probe('').stdout.trim()).toBe(`ok:unix:path=${join(runtime, 'bus')}`);
      // No bus at the derived path must report unavailable, not pretend success.
      expect(probe(`rm -f '${join(runtime, 'bus')}'`).stdout.trim()).toBe('no');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('--no-session-scope writes no slice', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-slice-'));
    try {
      const result = install(home, ['--no-session-scope']);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(slicePath(home))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);
});
