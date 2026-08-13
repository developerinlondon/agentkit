import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = join(import.meta.dir, '..', '..');
const injectHook = join(repoRoot, 'hooks', 'claude', 'brain-inject.sh');
const indexHook = join(repoRoot, 'hooks', 'claude', 'brain-index.sh');

function runHook(script: string, projectDir: string, input = '', cwd?: string) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    input,
    cwd,
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
  function bigVault(noteCount: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'brain-cap-'));
    mkdirSync(join(dir, 'brain', 'big'), { recursive: true });
    mkdirSync(join(dir, 'brain', 'small'), { recursive: true });
    writeFileSync(join(dir, 'brain', 'index.md'), '# Brain\n');
    for (let i = 0; i < noteCount; i++) {
      writeFileSync(join(dir, 'brain', 'big', `n${i}.md`), 'note\n');
    }
    writeFileSync(join(dir, 'brain', 'small', 'one.md'), 'note\n');
    return dir;
  }

  function rebuild(dir: string, cap?: string) {
    const env: Record<string, string> = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    if (cap !== undefined) env.AGENTKIT_BRAIN_INDEX_MAX_PER_SECTION = cap;
    spawnSync('bash', [indexHook], {
      encoding: 'utf8',
      input: writePayload(join(dir, 'brain', 'small', 'one.md')),
      env,
    });
    return readFileSync(join(dir, 'brain', 'index.md'), 'utf8');
  }

  // The index is injected into every session. One line per note makes it grow
  // without bound, which is the defect this cap exists to prevent.
  test('summarises a section past the cap and leaves small sections listed', () => {
    const dir = bigVault(25);
    try {
      const index = rebuild(dir);
      expect(index).toContain('- 25 notes — `ls brain/big/`');
      expect(index).not.toContain('[[big/n0]]');
      expect(index).toContain('[[small/one]]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cap is configurable and 0 disables it', () => {
    const dir = bigVault(25);
    try {
      expect(rebuild(dir, '30')).toContain('[[big/n0]]');
      expect(rebuild(dir, '5')).toContain('- 25 notes —');
      expect(rebuild(dir, '0')).toContain('[[big/n0]]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a non-numeric cap falls back to the default rather than disabling it', () => {
    const dir = bigVault(25);
    try {
      expect(rebuild(dir, 'abc')).toContain('- 25 notes —');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  test('keeps notes in directories with spaces and glob or regex metacharacters', () => {
    const dir = vaultProject();
    try {
      mkdirSync(join(dir, 'brain', 'tools & libs'), { recursive: true });
      mkdirSync(join(dir, 'brain', '[draft]'), { recursive: true });
      writeFileSync(join(dir, 'brain', 'tools & libs', 'jq.md'), 'note\n');
      writeFileSync(join(dir, 'brain', '[draft]', 'wip.md'), 'note\n');
      const run = runHook(indexHook, dir, writePayload(join(dir, 'brain', 'topic.md')));
      expect(run.status, run.stderr).toBe(0);
      const index = readFileSync(join(dir, 'brain', 'index.md'), 'utf8');
      expect(index).toContain('- [[tools & libs/jq]]');
      expect(index).toContain('- [[[draft]/wip]]');
      expect(index).toContain('- [[principles/one]]');
      expect(index).toContain('- [[topic]]');

      // A second run over the unchanged tree must not replace the file —
      // inode stability is the observable, content alone cannot tell a
      // rebuild from an early exit.
      const before = statSync(join(dir, 'brain', 'index.md'));
      runHook(indexHook, dir, writePayload(join(dir, 'brain', 'topic.md')));
      expect(statSync(join(dir, 'brain', 'index.md')).ino).toBe(before.ino);
      expect(readdirSync(join(dir, 'brain')).filter((f) => f.startsWith('.index-rebuild.')))
        .toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a relative brain/ path in another directory does not touch the project vault', () => {
    const project = vaultProject();
    const elsewhere = mkdtempSync(join(tmpdir(), 'brain-elsewhere-'));
    try {
      mkdirSync(join(elsewhere, 'brain'));
      writeFileSync(join(elsewhere, 'brain', 'other.md'), 'note\n');
      const before = readFileSync(join(project, 'brain', 'index.md'), 'utf8');
      const run = runHook(indexHook, project, writePayload('brain/other.md'), elsewhere);
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(join(project, 'brain', 'index.md'), 'utf8')).toBe(before);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
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
