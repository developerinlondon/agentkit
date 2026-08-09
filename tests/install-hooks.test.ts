import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
// The review gate is an explicit opt-in kit: nothing installs it implicitly.
const WITH_REVIEW = ['--with', 'adversarial-review'];
// Full canonical parity needs every hook-owning kit selected.
const WITH_ALL_HOOK_KITS = [...WITH_REVIEW, '--with', 'memory'];
const WITH_MEMORY = ['--with', 'memory'];
// Hook wiring is what these pin, not dependency fetching. The real bun-install
// path is exercised once, by the first test in tests/install-prompt.test.ts.
const skipSkillDeps = { AGENTKIT_SKIP_SKILL_DEPS: '1' };

function runGlobalInstall(
  home: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
) {
  return spawnSync('bash', [installScript, '--global', '--no-session-scope', ...extraArgs], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...skipSkillDeps,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      // Pinned rather than inherited: a runner with AGENTKIT_HOME exported would
      // otherwise install into it and assert against the temp home.
      AGENTKIT_HOME: join(home, '.agentkit'),
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: globalInstallTimeoutMs,
  });
}

function commandNames(entries: { command: string }[]): string[] {
  return entries.map((entry) => entry.command.split('/').pop() ?? '');
}

function installedSettings(claudeDir: string): any {
  return JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
}

// The installed wiring must equal the canonical file, not a second copy
// maintained by hand — the drift between them left review-police shipped
// but never wired, so the merge gate was inert wherever this installer ran.
const canonical = JSON.parse(
  readFileSync(join(repoRoot, 'hooks', 'claude', 'settings.json'), 'utf-8'),
);

describe('Claude Code and Codex hook wiring', () => {
  test('wires every shipped police hook into settings.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));

    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });

      const result = runGlobalInstall(home, {}, WITH_ALL_HOOK_KITS);
      expect(result.status, result.stderr.toString()).toBe(0);

      const settings = installedSettings(claudeDir);
      for (const event of Object.keys(canonical.hooks)) {
        const want = canonical.hooks[event];
        const got = settings.hooks[event];
        expect(got, `${event} missing from installed settings`).toBeDefined();
        expect(got).toHaveLength(want.length);
        want.forEach((kit: any, i: number) => {
          expect(got[i].matcher).toEqual(kit.matcher);
          expect(commandNames(got[i].hooks)).toEqual(commandNames(kit.hooks));
        });
      }

      // Every command must point at the installed hooks dir, never the token.
      for (const kits of Object.values<any>(settings.hooks)) {
        for (const kit of kits) {
          for (const entry of kit.hooks) {
            expect(entry.command).not.toContain('$HOME');
            expect(entry.command).toStartWith(join(claudeDir, 'hooks'));
          }
        }
      }

      // Named explicitly so deleting one from the canonical file fails here.
      expect(commandNames(settings.hooks.PreToolUse[0].hooks)).toContain('review-police.sh');
      expect(commandNames(settings.hooks.PostToolUse[0].hooks)).toContain('comment-police.sh');
      expect(commandNames(settings.hooks.PostToolUse[0].hooks)).toContain('brain-index.sh');
      expect(
        settings.hooks.SessionStart.flatMap((kit: any) => commandNames(kit.hooks)),
      ).toContain('brain-inject.sh');

      const codexDir = join(home, '.codex');
      const codexHooks = JSON.parse(readFileSync(join(codexDir, 'hooks.json'), 'utf-8'));
      expect(codexHooks.hooks.PreToolUse).toHaveLength(2);
      for (const kit of codexHooks.hooks.PreToolUse) {
        expect(kit.hooks).toHaveLength(1);
        expect(kit.hooks[0].command).toContain(
          `'${realpathSync(join(codexDir, 'hooks'))}'/review-police.sh`,
        );
        expect(kit.hooks[0].command).not.toContain('__AGENTKIT_CODEX_HOOKS_ROOT__');
      }
      for (const path of [
        join(codexDir, 'hooks', 'fail-closed-hook.sh'),
        join(codexDir, 'hooks', 'review-police.sh'),
        join(codexDir, 'tools', 'review-gate'),
        join(codexDir, 'tools', 'review-profile'),
      ]) {
        expect(existsSync(path), path).toBe(true);
        expect(statSync(path).mode & 0o111, path).not.toBe(0);
      }
      expect(existsSync(join(codexDir, 'hooks', 'lib', 'hook-input.sh'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('leaves the review gate out of a default install', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));
    const claudeDir = join(home, '.claude');

    try {
      const result = runGlobalInstall(home);
      expect(result.status, result.stderr.toString()).toBe(0);
      const settings = installedSettings(claudeDir);

      // The canonical file carries the whole wiring; a default install ships it
      // minus the kit-owned hooks: the review gate leaves the Bash kit and takes
      // the merge-shaped matcher kit with it, the brain hooks leave PostToolUse
      // and take the SessionStart kit with them. The write-gate kit is core and
      // stays.
      expect(canonical.hooks.PreToolUse).toHaveLength(3);
      expect(settings.hooks.PreToolUse.map((kit: any) => kit.matcher)).toEqual(['Bash', 'Edit|Write']);
      expect(commandNames(settings.hooks.PreToolUse[1].hooks)).toEqual(['plan-police.sh']);
      expect(commandNames(settings.hooks.PreToolUse[0].hooks)).toEqual(
        commandNames(canonical.hooks.PreToolUse[0].hooks).filter(
          (name) => name !== 'review-police.sh',
        ),
      );
      expect(commandNames(settings.hooks.PostToolUse[0].hooks)).toEqual(
        commandNames(canonical.hooks.PostToolUse[0].hooks).filter(
          (name) => name !== 'brain-index.sh',
        ),
      );
      // The update-notice kit is core and stays; only the brain-inject kit
      // leaves with the memory kit.
      expect(canonical.hooks.SessionStart).toHaveLength(2);
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(commandNames(settings.hooks.SessionStart[0].hooks)).toEqual(['update-notice.sh']);
      for (const kits of Object.values<any>(settings.hooks)) {
        for (const kit of kits) {
          for (const entry of kit.hooks) {
            expect(entry.command).not.toContain('review-police.sh');
            expect(entry.command).not.toContain('fail-closed-hook.sh');
            expect(entry.command).not.toContain('brain-');
          }
        }
      }

      for (const path of [
        join(claudeDir, 'hooks', 'review-police.sh'),
        join(claudeDir, 'hooks', 'fail-closed-hook.sh'),
        join(claudeDir, 'hooks', 'brain-inject.sh'),
        join(claudeDir, 'hooks', 'brain-index.sh'),
        join(claudeDir, 'tools', 'review-gate'),
        join(claudeDir, 'tools', 'review-profile'),
        join(home, '.codex', 'hooks.json'),
        join(home, '.codex', 'hooks', 'review-police.sh'),
        join(home, '.codex', 'hooks', 'fail-closed-hook.sh'),
        join(home, '.codex', 'tools', 'review-gate'),
        join(home, '.codex', 'tools', 'review-profile'),
      ]) {
        expect(existsSync(path), path).toBe(false);
      }
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('--with memory wires the brain hooks without the review gate', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));
    const claudeDir = join(home, '.claude');

    try {
      const result = runGlobalInstall(home, {}, WITH_MEMORY);
      expect(result.status, result.stderr.toString()).toBe(0);
      const settings = installedSettings(claudeDir);

      expect(commandNames(settings.hooks.PostToolUse[0].hooks)).toContain('brain-index.sh');
      expect(settings.hooks.SessionStart).toHaveLength(2);
      expect(commandNames(settings.hooks.SessionStart[1].hooks)).toEqual(['brain-inject.sh']);
      for (const kits of Object.values<any>(settings.hooks)) {
        for (const kit of kits) {
          for (const entry of kit.hooks) {
            expect(entry.command).not.toContain('review-police.sh');
          }
        }
      }
      for (const name of ['brain-inject.sh', 'brain-index.sh']) {
        const path = join(claudeDir, 'hooks', name);
        expect(existsSync(path), path).toBe(true);
        expect(statSync(path).mode & 0o111, path).not.toBe(0);
      }
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('deselecting the memory kit removes installed brain hooks and their wiring', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));
    const claudeDir = join(home, '.claude');

    try {
      let result = runGlobalInstall(home, {}, WITH_MEMORY);
      expect(result.status, result.stderr.toString()).toBe(0);
      result = runGlobalInstall(home, {}, ['--without', 'memory']);
      expect(result.status, result.stderr.toString()).toBe(0);

      const settings = installedSettings(claudeDir);
      expect(commandNames(settings.hooks.PostToolUse[0].hooks)).not.toContain('brain-index.sh');
      expect(
        settings.hooks.SessionStart.flatMap((kit: any) => commandNames(kit.hooks)),
      ).not.toContain('brain-inject.sh');
      for (const name of ['brain-inject.sh', 'brain-index.sh']) {
        expect(existsSync(join(claudeDir, 'hooks', name)), name).toBe(false);
      }
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, 2 * globalInstallTimeoutMs);

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

      let result = runGlobalInstall(home, {}, WITH_REVIEW);
      expect(result.status, result.stderr.toString()).toBe(0);
      result = runGlobalInstall(home, {}, WITH_REVIEW);
      expect(result.status, result.stderr.toString()).toBe(0);

      const settings = installedSettings(claudeDir);
      expect(settings.model).toBe('opus');
      expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();

      const codexHooks = JSON.parse(readFileSync(join(codexDir, 'hooks.json'), 'utf-8'));
      expect(codexHooks.description).toBe('keep me');
      expect(codexHooks.hooks.Stop[0].hooks[0].command).toBe('/tmp/unrelated-hook');
      const preToolCommands = codexHooks.hooks.PreToolUse.flatMap((kit: any) =>
        kit.hooks.map((entry: any) => entry.command),
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
      const result = runGlobalInstall(home, { CODEX_HOME: codexHome }, WITH_REVIEW);
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
      expect(existsSync(join(codexHome, 'config.toml'))).toBe(true);
      expect(existsSync(join(codexHome, 'hooks', 'review-police.sh'))).toBe(true);
      expect(existsSync(join(codexHome, 'tools', 'review-profile'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
      expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  // The installed layout is a flat hooks dir one level shallower than the source
  // tree, so a hook that resolves a helper beside itself is only proven here.
  test('the installed hooks run from the layout install.sh actually writes', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));
    try {
      const install = runGlobalInstall(home);
      expect(install.status, install.stderr.toString()).toBe(0);
      const settings = installedSettings(join(home, '.claude'));
      const bashHooks = settings.hooks.PreToolUse[0].hooks as { command: string }[];

      const issueHook = bashHooks.find((entry) => entry.command.includes('issue-police.sh'));
      expect(issueHook).toBeDefined();
      const refused = spawnSync('bash', ['-c', issueHook!.command], {
        cwd: home,
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        input: JSON.stringify({ tool_input: { command: 'gh issue create --title x --body y' } }),
        timeout: 10_000,
      });
      expect(refused.stdout).toContain('"deny"');

      // git-police's WIP cap sources lib/forge-branches.sh from beside itself.
      // The origin is a local path no forge CLI can serve, so the unreachable
      // reminder is what proves the helper loaded at all.
      const repo = join(home, 'repo');
      mkdirSync(repo);
      for (
        const cmd of [
          'git init -q -b main',
          `git remote add origin ${join(home, 'nowhere.git')}`,
          'git config user.email t@e.com',
          'git config user.name t',
          'git commit -q --allow-empty -m init',
          'git checkout -q -b feat/started',
          'git commit -q --allow-empty -m work',
          'git checkout -q main',
        ]
      ) {
        spawnSync('bash', ['-c', cmd], { cwd: repo, encoding: 'utf-8' });
      }
      const gitHook = bashHooks.find((entry) => entry.command.includes('git-police.sh'));
      const advised = spawnSync('bash', ['-c', gitHook!.command], {
        cwd: repo,
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        input: JSON.stringify({ tool_input: { command: 'git checkout -b feat/next' } }),
        timeout: 15_000,
      });
      expect(advised.stdout).toContain('UNCHECKED');
      expect(advised.stdout).toContain('feat/started');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('quotes shell-active CODEX_HOME paths before a trusted hook executes', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-hooks-'));
    const codexHome = join(
      home,
      "codex ' $(touch codex-hook-dollar) `touch codex-hook-backtick`",
    );

    try {
      const install = runGlobalInstall(home, { CODEX_HOME: codexHome }, WITH_REVIEW);
      expect(install.status, install.stderr.toString()).toBe(0);

      const codexHooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf-8'));
      const command = codexHooks.hooks.PreToolUse[0].hooks[0].command;
      const hook = spawnSync('bash', ['-c', command], {
        cwd: home,
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'printf safe' },
          session_id: 'codex-shell-path-test',
        }),
        timeout: 5_000,
      });

      expect(hook.status, hook.stderr).toBe(0);
      expect(existsSync(join(home, 'codex-hook-dollar'))).toBe(false);
      expect(existsSync(join(home, 'codex-hook-backtick'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('fails Codex hook installation loudly when jq is unavailable', () => {
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

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('jq is required to install the Codex review hook');
      expect(result.stdout).not.toContain('skipping Codex review hook wiring');
      expect(existsSync(codexHome)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
