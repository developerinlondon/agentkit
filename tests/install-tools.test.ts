import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const installScript = join(repoRoot, 'install.sh');

describe('standalone tool installation', () => {
  test('installs global tools into PATH and preserves the Claude tools mirror', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-tools-'));

    try {
      const result = spawnSync('bash', [installScript, '--global'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
        },
        encoding: 'utf-8',
      });
      expect(result.status, result.stderr).toBe(0);

      const pathTool = join(home, '.local', 'bin', 'bounded-run');
      const claudeTool = join(home, '.claude', 'tools', 'bounded-run');
      expect(readFileSync(pathTool, 'utf-8')).toBe(readFileSync(claudeTool, 'utf-8'));
      expect(statSync(pathTool).mode & 0o111).not.toBe(0);
      expect(statSync(claudeTool).mode & 0o111).not.toBe(0);
      const compatAlias = join(home, '.local', 'bin', 'agentkit-run');
      expect(lstatSync(compatAlias).isSymbolicLink()).toBe(true);
      expect(readFileSync(compatAlias, 'utf-8')).toBe(readFileSync(pathTool, 'utf-8'));
      expect(result.stdout).toContain(`PATH tools:      ${join(home, '.local', 'bin')}/`);
      expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'resource-police.ts'))).toBe(
        true,
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('ships the runner inside the one-shot Claude plugin', () => {
    const source = readFileSync(join(repoRoot, 'tools', 'bounded-run'), 'utf-8');
    const bundled = join(repoRoot, 'plugins-cc', 'agentkit', 'tools', 'bounded-run');
    expect(readFileSync(bundled, 'utf-8')).toBe(source);
    expect(statSync(bundled).mode & 0o111).not.toBe(0);
  });
});

const runInstall = (home: string, platform?: string) =>
  spawnSync('bash', [installScript, '--global'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      ...(platform === undefined ? {} : { AGENTKIT_PLATFORM: platform }),
    },
    encoding: 'utf-8',
  });

// existsSync follows symlinks, so it reports false for a dangling link that is
// still on disk. Gating has to remove the link itself, not just its target.
const pathPresent = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const withHome = (body: (home: string) => void) => {
  const home = mkdtempSync(join(tmpdir(), 'agentkit-platform-'));
  try {
    body(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
};

// bounded-run drives systemd-run and cgroupfs directly, so installing it on a
// non-Linux host hands the agent a command that cannot work.
describe('tool platform gating', () => {
  test('does not install a Linux-only tool on a darwin host', () => {
    withHome((home) => {
      const result = runInstall(home, 'darwin');
      expect(result.status, result.stderr).toBe(0);

      expect(existsSync(join(home, '.local', 'bin', 'bounded-run'))).toBe(false);
      expect(existsSync(join(home, '.claude', 'tools', 'bounded-run'))).toBe(false);
      expect(result.stdout).toContain('Skipping (unsupported on darwin): bounded-run');
    });
  });

  // Removal of an already-present alias is covered by the reconcile test below;
  // on a fresh skip there is nothing to remove, only something not to create.
  test('does not create the agentkit-run alias when its target is skipped', () => {
    withHome((home) => {
      expect(runInstall(home, 'darwin').status).toBe(0);
      expect(pathPresent(join(home, '.local', 'bin', 'agentkit-run'))).toBe(false);
    });
  });

  test('installs tools that declare no platforms everywhere', () => {
    withHome((home) => {
      expect(runInstall(home, 'darwin').status).toBe(0);
      expect(existsSync(join(home, '.local', 'bin', 'fix-ascii-boxes.py'))).toBe(true);
    });
  });

  test('removes a tool already installed before it declared its platforms', () => {
    withHome((home) => {
      expect(runInstall(home, 'linux').status).toBe(0);
      const tool = join(home, '.local', 'bin', 'bounded-run');
      const alias = join(home, '.local', 'bin', 'agentkit-run');
      expect(existsSync(tool)).toBe(true);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);

      // Same host, later agentkit version: the gate must reconcile, not just skip.
      expect(runInstall(home, 'darwin').status).toBe(0);
      expect(pathPresent(tool)).toBe(false);
      expect(pathPresent(join(home, '.claude', 'tools', 'bounded-run'))).toBe(false);
      expect(pathPresent(alias)).toBe(false);
    });
  });

  test('detects the host platform when no override is set', () => {
    withHome((home) => {
      const result = runInstall(home);
      expect(result.status, result.stderr).toBe(0);
      // The suite runs on Linux; bounded-run is supported here.
      expect(existsSync(join(home, '.local', 'bin', 'bounded-run'))).toBe(true);
      expect(result.stdout).not.toContain('Skipping (unsupported');
    });
  });
});
