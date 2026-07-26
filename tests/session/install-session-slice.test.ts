import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(import.meta.dir));
const installScript = join(repoRoot, 'install.sh');

function install(home: string, extraArgs: string[] = []) {
  return spawnSync('bash', [installScript, '--global', ...extraArgs], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    encoding: 'utf-8',
  });
}

function slicePath(home: string) {
  return join(home, '.config', 'systemd', 'user', 'agent-sessions.slice');
}

describe('aggregate session slice', () => {
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
  });

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
  });

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
  });
});
