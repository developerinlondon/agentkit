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
      const result = spawnSync('bash', [installScript, '--global', '--no-session-scope'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          AGENTKIT_PLATFORM: 'linux',
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
      const pathReviewGate = join(home, '.local', 'bin', 'review-gate');
      const claudeReviewGate = join(home, '.claude', 'tools', 'review-gate');
      expect(readFileSync(pathReviewGate, 'utf-8')).toBe(readFileSync(claudeReviewGate, 'utf-8'));
      expect(statSync(pathReviewGate).mode & 0o111).not.toBe(0);
      expect(statSync(claudeReviewGate).mode & 0o111).not.toBe(0);
      expect(result.stdout).toContain(`PATH tools:      ${join(home, '.local', 'bin')}/`);
      expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'resource-police.ts'))).toBe(
        true,
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, 60_000);

  test('ships the runner inside the one-shot Claude plugin', () => {
    const source = readFileSync(join(repoRoot, 'tools', 'bounded-run'), 'utf-8');
    const bundled = join(repoRoot, 'plugins-cc', 'agentkit', 'tools', 'bounded-run');
    expect(readFileSync(bundled, 'utf-8')).toBe(source);
    expect(statSync(bundled).mode & 0o111).not.toBe(0);
  });

  test('ships the evidence validator inside the one-shot Claude plugin', () => {
    const source = readFileSync(join(repoRoot, 'tools', 'review-gate'), 'utf-8');
    const bundled = join(repoRoot, 'plugins-cc', 'agentkit', 'tools', 'review-gate');
    expect(readFileSync(bundled, 'utf-8')).toBe(source);
    expect(statSync(bundled).mode & 0o111).not.toBe(0);
  });
});
