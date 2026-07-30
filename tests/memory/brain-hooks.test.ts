import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = join(import.meta.dir, '..', '..');
const injectHook = join(repoRoot, 'hooks', 'claude', 'brain-inject.sh');
const indexHook = join(repoRoot, 'hooks', 'claude', 'brain-index.sh');

function runHook(script: string, projectDir: string, input = '') {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

const writePayload = (path: string) =>
  JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path } });

function vaultProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-hooks-'));
  mkdirSync(join(dir, 'brain', 'principles'), { recursive: true });
  writeFileSync(join(dir, 'brain', 'index.md'), '# Brain\n');
  writeFileSync(join(dir, 'brain', 'principles', 'one.md'), 'note\n');
  writeFileSync(join(dir, 'brain', 'topic.md'), 'note\n');
  return dir;
}

describe('brain-index.sh', () => {
  test('rebuilds the index grouped by directory with standalone files under Other', () => {
    const dir = vaultProject();
    try {
      const run = runHook(indexHook, dir, writePayload(join(dir, 'brain', 'topic.md')));
      expect(run.status, run.stderr).toBe(0);
      const index = readFileSync(join(dir, 'brain', 'index.md'), 'utf8');
      expect(index).toContain('## Principles');
      expect(index).toContain('- [[principles/one]]');
      expect(index).toContain('## Other');
      expect(index).toContain('- [[topic]]');
      expect(index).not.toContain('[[index]]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('drops deleted notes from the index on the next brain write', () => {
    const dir = vaultProject();
    try {
      runHook(indexHook, dir, writePayload(join(dir, 'brain', 'topic.md')));
      unlinkSync(join(dir, 'brain', 'principles', 'one.md'));
      runHook(indexHook, dir, writePayload(join(dir, 'brain', 'topic.md')));
      const index = readFileSync(join(dir, 'brain', 'index.md'), 'utf8');
      expect(index).not.toContain('principles/one');
      expect(index).toContain('- [[topic]]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores writes outside brain/ and projects without a vault index', () => {
    const dir = vaultProject();
    try {
      const before = readFileSync(join(dir, 'brain', 'index.md'), 'utf8');
      const outside = runHook(indexHook, dir, writePayload(join(dir, 'src.ts')));
      expect(outside.status, outside.stderr).toBe(0);
      expect(readFileSync(join(dir, 'brain', 'index.md'), 'utf8')).toBe(before);

      unlinkSync(join(dir, 'brain', 'index.md'));
      const noVault = runHook(indexHook, dir, writePayload(join(dir, 'brain', 'topic.md')));
      expect(noVault.status, noVault.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('brain-inject.sh', () => {
  test('prints the index when a vault exists and nothing otherwise', () => {
    const dir = vaultProject();
    try {
      const withVault = runHook(injectHook, dir);
      expect(withVault.status, withVault.stderr).toBe(0);
      expect(withVault.stdout).toContain('Brain vault index');
      expect(withVault.stdout).toContain('# Brain');

      rmSync(join(dir, 'brain'), { recursive: true, force: true });
      const without = runHook(injectHook, dir);
      expect(without.status, without.stderr).toBe(0);
      expect(without.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
