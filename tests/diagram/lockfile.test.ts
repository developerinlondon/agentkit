import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const diagramDir = join(repoRoot, 'skills', 'diagram');

// `--dry-run` resolves against the lockfile without writing node_modules, so
// this never pays the 271 MB the skill's real dependency tree costs — it
// settles in milliseconds against an in-sync lockfile.
function dryRun(cwd: string): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ['bun', 'install', '--frozen-lockfile', '--dry-run'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe('skills/diagram/bun.lock is checked without a full install', () => {
  test('the committed lockfile matches package.json', () => {
    const result = dryRun(diagramDir);
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  });

  test('a drifted lockfile is refused, not silently accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diagram-lockfile-'));
    try {
      cpSync(join(diagramDir, 'bun.lock'), join(dir, 'bun.lock'));
      const pkg = JSON.parse(readFileSync(join(diagramDir, 'package.json'), 'utf-8'));
      pkg.dependencies = { ...pkg.dependencies, 'left-pad': '^1.3.0' };
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

      const result = dryRun(dir);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('lockfile');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
