import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const installScript = join(repoRoot, 'install.sh');

function runGlobalInstall(home: string) {
  return spawnSync('bash', [installScript, '--global'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
    },
    encoding: 'utf-8',
  });
}

function commandNames(entries: { command: string }[]): string[] {
  return entries.map((entry) => entry.command.split('/').pop() ?? '');
}

describe('Claude Code hook wiring', () => {
  test('wires every shipped police hook into settings.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));

    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });

      const result = runGlobalInstall(home);
      expect(result.status, result.stderr.toString()).toBe(0);

      const settings = JSON.parse(
        readFileSync(join(claudeDir, 'settings.json'), 'utf-8'),
      );

      const preToolUse = settings.hooks.PreToolUse;
      expect(preToolUse).toHaveLength(1);
      expect(preToolUse[0].matcher).toBe('Bash');
      expect(commandNames(preToolUse[0].hooks).sort()).toEqual(
        ['git-police.sh', 'kubectl-police.sh', 'pkg-police.sh'].sort(),
      );

      const postToolUse = settings.hooks.PostToolUse;
      expect(postToolUse).toHaveLength(1);
      expect(postToolUse[0].matcher).toBe('Edit|Write');
      expect(commandNames(postToolUse[0].hooks).sort()).toEqual(
        ['coding-police.sh', 'format-police.sh'].sort(),
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('preserves existing top-level settings keys when merging hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));

    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify(
          {
            model: 'opus',
            permissions: { allow: ['Bash(ls:*)'] },
          },
          null,
          2,
        ),
      );

      const result = runGlobalInstall(home);
      expect(result.status, result.stderr.toString()).toBe(0);

      const settings = JSON.parse(
        readFileSync(join(claudeDir, 'settings.json'), 'utf-8'),
      );
      expect(settings.model).toBe('opus');
      expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
