import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const installScript = join(repoRoot, 'install.sh');
const installSource = readFileSync(installScript, 'utf-8');
const codexFunctions = installSource.slice(
  installSource.indexOf('merge_codex_hooks() {'),
  installSource.indexOf('\n# ─── Per-Session Resource Shims', installSource.indexOf('merge_codex_hooks() {')),
);
// A global install intentionally installs and builds dependency-bearing skills.
const globalInstallTimeoutMs = 60_000;

function runGlobalInstall(home: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [installScript, '--global', '--no-session-scope'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: globalInstallTimeoutMs,
  });
}

function commandNames(entries: { command: string }[]): string[] {
  return entries.map((entry) => entry.command.split('/').pop() ?? '');
}

describe('Claude Code and Codex hook wiring', () => {
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

      const codexDir = join(home, '.codex');
      const codexHooks = JSON.parse(readFileSync(join(codexDir, 'hooks.json'), 'utf-8'));
      expect(codexHooks.hooks.PreToolUse).toHaveLength(2);
      for (const group of codexHooks.hooks.PreToolUse) {
        expect(group.hooks).toHaveLength(1);
        expect(group.hooks[0].command).toContain(join(codexDir, 'hooks', 'review-police.sh'));
        expect(group.hooks[0].command).not.toContain('__AGENTKIT_CODEX_HOOKS_ROOT__');
      }
      for (const path of [
        join(codexDir, 'hooks', 'fail-closed-hook.sh'),
        join(codexDir, 'hooks', 'review-police.sh'),
        join(codexDir, 'tools', 'review-gate'),
      ]) {
        expect(existsSync(path), path).toBe(true);
        expect(statSync(path).mode & 0o111, path).not.toBe(0);
      }
      expect(existsSync(join(codexDir, 'hooks', 'lib', 'hook-input.sh'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('preserves existing top-level settings keys when merging hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));

    try {
      const claudeDir = join(home, '.claude');
      const codexDir = join(home, '.codex');
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(codexDir, { recursive: true });
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
      writeFileSync(
        join(codexDir, 'hooks.json'),
        JSON.stringify({
          description: 'keep me',
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: '/tmp/unrelated-hook' }] }],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: '/tmp/unrelated-policy' },
                  { type: 'command', command: '/old/review-police.sh' },
                ],
              },
            ],
          },
        }),
      );

      let result = runGlobalInstall(home);
      expect(result.status, result.stderr.toString()).toBe(0);
      result = runGlobalInstall(home);
      expect(result.status, result.stderr.toString()).toBe(0);

      const settings = JSON.parse(
        readFileSync(join(claudeDir, 'settings.json'), 'utf-8'),
      );
      expect(settings.model).toBe('opus');
      expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();

      const codexHooks = JSON.parse(readFileSync(join(codexDir, 'hooks.json'), 'utf-8'));
      expect(codexHooks.description).toBe('keep me');
      expect(codexHooks.hooks.Stop[0].hooks[0].command).toBe('/tmp/unrelated-hook');
      const preToolCommands = codexHooks.hooks.PreToolUse.flatMap((group: any) =>
        group.hooks.map((entry: any) => entry.command),
      );
      expect(preToolCommands).toContain('/tmp/unrelated-policy');
      expect(preToolCommands).toContain('/old/review-police.sh');
      expect(
        preToolCommands.filter((command: string) =>
          command.includes('AGENTKIT_HOOK_TARGET=codex'),
        ),
      ).toHaveLength(2);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, 2 * globalInstallTimeoutMs);

  test('installs global Codex artifacts under CODEX_HOME when configured', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));
    const codexHome = join(home, 'custom-codex-home');

    try {
      const result = runGlobalInstall(home, { CODEX_HOME: codexHome });
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
      expect(existsSync(join(codexHome, 'config.toml'))).toBe(true);
      expect(existsSync(join(codexHome, 'hooks', 'review-police.sh'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
      expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('skips optional Codex hook wiring cleanly when jq is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-hooks-no-jq-'));
    const codexHome = join(root, 'codex-home');

    try {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
REPO_DIR="$1"
${codexFunctions}
install_codex_review_hooks "$2"`,
          'agentkit-codex-no-jq',
          repoRoot,
          codexHome,
        ],
        {
          encoding: 'utf-8',
          env: { ...process.env, PATH: '' },
          timeout: 5_000,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('jq not found; skipping Codex review hook wiring');
      expect(existsSync(codexHome)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
