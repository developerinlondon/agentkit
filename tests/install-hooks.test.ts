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

      // The installed wiring must equal the canonical file, not a second copy
      // maintained by hand — the drift between them left review-police shipped
      // but never wired, so the merge gate was inert wherever this installer ran.
      const canonical = JSON.parse(
        readFileSync(join(repoRoot, 'hooks', 'claude', 'settings.json'), 'utf-8'),
      );
      for (const event of Object.keys(canonical.hooks)) {
        const want = canonical.hooks[event];
        const got = settings.hooks[event];
        expect(got, `${event} missing from installed settings`).toBeDefined();
        expect(got).toHaveLength(want.length);
        want.forEach((group: any, i: number) => {
          expect(got[i].matcher).toEqual(group.matcher);
          expect(commandNames(got[i].hooks)).toEqual(commandNames(group.hooks));
        });
      }

      // Every command must point at the installed hooks dir, never the token.
      for (const groups of Object.values<any>(settings.hooks)) {
        for (const group of groups) {
          for (const entry of group.hooks) {
            expect(entry.command).not.toContain('$HOME');
            expect(entry.command).toStartWith(join(claudeDir, 'hooks'));
          }
        }
      }

      // Named explicitly so deleting one from the canonical file fails here.
      expect(commandNames(settings.hooks.PreToolUse[0].hooks)).toContain('review-police.sh');
      expect(commandNames(settings.hooks.PostToolUse[0].hooks)).toContain('comment-police.sh');
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
