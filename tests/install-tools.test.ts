import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

      const pathTool = join(home, '.local', 'bin', 'agentkit-run');
      const claudeTool = join(home, '.claude', 'tools', 'agentkit-run');
      expect(readFileSync(pathTool, 'utf-8')).toBe(readFileSync(claudeTool, 'utf-8'));
      expect(statSync(pathTool).mode & 0o111).not.toBe(0);
      expect(statSync(claudeTool).mode & 0o111).not.toBe(0);
      expect(result.stdout).toContain(`PATH tools:      ${join(home, '.local', 'bin')}/`);
      expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'resource-police.ts'))).toBe(
        true,
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('ships the runner inside the one-shot Claude plugin', () => {
    const source = readFileSync(join(repoRoot, 'tools', 'agentkit-run'), 'utf-8');
    const bundled = join(repoRoot, 'plugins-cc', 'agentkit', 'tools', 'agentkit-run');
    expect(readFileSync(bundled, 'utf-8')).toBe(source);
    expect(statSync(bundled).mode & 0o111).not.toBe(0);
  });
});
