import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const diagramDir = join(repoRoot, 'skills', 'diagram');

interface LockPackages {
  packages: Record<string, [string, ...unknown[]]>;
}

// `--frozen-lockfile --dry-run` only catches a structural package.json/lockfile
// mismatch; a hand-edited resolved version still reports clean. This does NOT
// catch an in-range resolved bump (^3.1.1 -> 3.1.2) — that is a legitimate
// update, caught by review, not by this check.
function outOfRangeResolutions(pkgPath: string, lockPath: string): string[] {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const declared: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const lock = Bun.JSONC.parse(readFileSync(lockPath, 'utf-8')) as LockPackages;

  const problems: string[] = [];
  for (const [name, range] of Object.entries(declared)) {
    const entry = lock.packages[name];
    if (!entry) {
      problems.push(`${name}: no resolved entry in bun.lock`);
      continue;
    }
    const resolved = entry[0].slice(name.length + 1);
    if (!Bun.semver.satisfies(resolved, range)) {
      problems.push(`${name}: resolved ${resolved} does not satisfy declared range ${range}`);
    }
  }
  return problems.sort();
}

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

describe('skills/diagram/bun.lock resolves within its declared ranges', () => {
  test('the committed lockfile has no out-of-range resolutions', () => {
    expect(outOfRangeResolutions(join(diagramDir, 'package.json'), join(diagramDir, 'bun.lock'))).toEqual([]);
  });

  test('a resolved version hand-edited outside its declared range is caught', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diagram-lockfile-range-'));
    try {
      const lockText = readFileSync(join(diagramDir, 'bun.lock'), 'utf-8');
      const mutated = lockText.replace('"@dagrejs/dagre@3.1.1"', '"@dagrejs/dagre@4.0.0"');
      expect(mutated).not.toBe(lockText);
      const lockPath = join(dir, 'bun.lock');
      writeFileSync(lockPath, mutated);

      const problems = outOfRangeResolutions(join(diagramDir, 'package.json'), lockPath);
      expect(problems).toEqual(['@dagrejs/dagre: resolved 4.0.0 does not satisfy declared range ^3.1.1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
