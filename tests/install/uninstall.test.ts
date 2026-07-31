import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(import.meta.dir));
const installScript = join(repoRoot, 'install.sh');

interface Fixture {
  home: string;
  repo: string;
  root: string;
  target: string;
}

function writeFixtureFile(path: string, contents: string, executable = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (executable) chmodSync(path, 0o755);
}

const canonicalClaudeSettings = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: '$HOME/.claude/hooks/git-police.sh', timeout: 10 }],
      },
    ],
    SessionStart: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: '$HOME/.claude/hooks/update-notice.sh', timeout: 10 }],
      },
    ],
  },
});

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-uninstall-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const target = join(root, 'project');
  for (const dir of [repo, home, target]) mkdirSync(dir, { recursive: true });

  copyFileSync(installScript, join(repo, 'install.sh'));
  chmodSync(join(repo, 'install.sh'), 0o755);
  for (const lib of ['install-platform.sh', 'skill-kits.sh']) {
    writeFixtureFile(join(repo, 'lib', lib), readFileSync(join(repoRoot, 'lib', lib), 'utf-8'));
  }

  writeFixtureFile(join(repo, 'config.example.yaml'), 'enforcement: {}\n');
  writeFixtureFile(join(repo, 'skills', 'sample', 'SKILL.md'), '---\nname: sample\n---\n\n# Sample\n');
  writeFixtureFile(
    join(repo, 'skills', 'KITS'),
    'kit core Sample core kit\nkit adversarial-review Sample review kit\nexplicit adversarial-review\n',
  );
  writeFixtureFile(join(repo, 'rules', 'sample-rule.md'), '# Sample rule\n');
  writeFixtureFile(
    join(repo, 'instructions', 'sample-prompt.md'),
    '# Sample Prompt\n\nAlways be sampled.\n',
  );
  writeFixtureFile(join(repo, 'plugins', 'sample-plugin.ts'), 'export const plugin = {};\n');

  writeFixtureFile(join(repo, 'hooks', 'claude', 'settings.json'), `${canonicalClaudeSettings}\n`);
  for (const hook of ['git-police.sh', 'update-notice.sh', 'fail-closed-hook.sh', 'review-police.sh']) {
    writeFixtureFile(join(repo, 'hooks', 'claude', hook), '#!/bin/sh\nexit 0\n', true);
  }
  writeFixtureFile(join(repo, 'hooks', 'claude', 'lib', 'hook-input.sh'), '# helper\n');
  writeFixtureFile(
    join(repo, 'hooks', 'codex', 'hooks.json'),
    '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"AGENTKIT_HOOK_TARGET=codex __AGENTKIT_CODEX_HOOKS_ROOT__/fail-closed-hook.sh 45 __AGENTKIT_CODEX_HOOKS_ROOT__/review-police.sh","timeout":60}]}]}}\n',
  );

  for (const tool of ['bounded-run', 'portable-tool', 'agent-session', 'review-gate', 'review-profile']) {
    writeFixtureFile(join(repo, 'tools', tool), `#!/usr/bin/env bash\nprintf '${tool}\\n'\n`, true);
  }
  writeFixtureFile(join(repo, 'policies', 'codex', 'sample-police.rules'), '# sample policy one\n');
  writeFixtureFile(join(repo, 'policies', 'codex', 'other-police.rules'), '# sample policy two\n');

  return { home, repo, root, target };
}

function run(fixture: Fixture, args: string[]) {
  return spawnSync('bash', [join(fixture.repo, 'install.sh'), ...args], {
    cwd: fixture.repo,
    env: {
      ...process.env,
      AGENTKIT_HOME: join(fixture.home, '.agentkit'),
      AGENTKIT_PLATFORM: 'linux',
      CI: '1',
      CODEX_HOME: join(fixture.home, '.codex'),
      HOME: fixture.home,
      XDG_CONFIG_HOME: join(fixture.home, '.config'),
      XDG_DATA_HOME: join(fixture.home, '.local', 'share'),
      // Keeps `systemctl --user` out of the run: both the installer and the
      // uninstaller probe this before touching a real user manager.
      XDG_RUNTIME_DIR: join(fixture.home, 'no-such-runtime'),
    },
    encoding: 'utf-8',
    timeout: 120_000,
  });
}

// existsSync follows symlinks, so a leftover link into a deleted shared root
// reads as absent. Only lstat sees the link itself still sitting there.
function expectMissing(path: string): void {
  expect(existsSync(path), path).toBe(false);
  expect(() => lstatSync(path), path).toThrow();
}

/** User-owned files planted before the install; every one must outlive it. */
function plantUserContent(fixture: Fixture): void {
  const { home } = fixture;
  writeFixtureFile(join(home, '.codex', 'rules', 'default.rules'), '# my own codex policy\n');
  writeFixtureFile(
    join(home, '.codex', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/mine/my-codex-hook.sh' }] },
        ],
      },
    }),
  );
  writeFixtureFile(join(home, '.claude', 'CLAUDE.md'), '# My Own Notes\n\nkeep me\n');
  writeFixtureFile(join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md'), '# Mine\n');
  writeFixtureFile(join(home, '.local', 'bin', 'my-own-tool'), '#!/bin/sh\n', true);
  writeFixtureFile(join(home, '.bashrc'), 'export MY_OWN=1\n');
  writeFixtureFile(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      instructions: ['/opt/mine/my-own-prompt.md'],
      theme: 'mine',
    }),
  );
}

function expectUserContentIntact(fixture: Fixture): void {
  const { home } = fixture;
  expect(existsSync(join(home, '.codex', 'rules', 'default.rules'))).toBe(true);
  expect(existsSync(join(home, '.local', 'bin', 'my-own-tool'))).toBe(true);
  expect(existsSync(join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md'))).toBe(true);

  const codexHooks = readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8');
  expect(codexHooks).toContain('/opt/mine/my-codex-hook.sh');
  expect(codexHooks).not.toContain('AGENTKIT_HOOK_TARGET=codex');

  const claudeMd = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8');
  expect(claudeMd).toContain('keep me');
  expect(claudeMd).not.toContain('agentkit:sample-prompt');
  expect(claudeMd).not.toContain('Always be sampled.');

  const bashrc = readFileSync(join(home, '.bashrc'), 'utf-8');
  expect(bashrc).toContain('export MY_OWN=1');
  expect(bashrc).not.toContain('agentkit session shims');

  const opencode = JSON.parse(
    readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf-8'),
  );
  expect(opencode.instructions).toEqual(['/opt/mine/my-own-prompt.md']);
  expect(opencode.theme).toBe('mine');
}

describe('install.sh --uninstall (global)', () => {
  test('removes every managed artifact and reverts every managed config edit', () => {
    const fixture = createFixture();
    const { home } = fixture;
    try {
      plantUserContent(fixture);

      const installed = run(fixture, ['--global', '--with', 'adversarial-review']);
      expect(installed.status, installed.stderr).toBe(0);

      // The install must have produced what the uninstall is asked to remove.
      expect(existsSync(join(home, '.agentkit', 'skills', 'sample'))).toBe(true);
      expect(existsSync(join(home, '.local', 'bin', 'bounded-run'))).toBe(true);
      expect(existsSync(join(home, '.claude', 'hooks', 'git-police.sh'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'prompts', 'sample.md'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'rules', 'sample-police.rules'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'rules', 'other-police.rules'))).toBe(true);
      expect(existsSync(join(home, '.codex', 'tools', 'review-gate'))).toBe(true);
      expect(existsSync(join(home, '.config', 'systemd', 'user', 'agent-sessions.slice'))).toBe(true);
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).toContain('Sample Prompt');
      expect(readFileSync(join(home, '.bashrc'), 'utf-8')).toContain('agentkit session shims');

      // A hook the operator wired in after installing agentkit.
      const settingsPath = join(home, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      settings.model = 'opus';
      settings.hooks.PreToolUse.push({
        matcher: 'Write',
        hooks: [{ type: 'command', command: '/opt/mine/my-own-hook.sh' }],
      });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      const removed = run(fixture, ['--global', '--uninstall']);
      expect(removed.status, removed.stderr).toBe(0);

      expectMissing(join(home, '.agentkit'));
      const goneTools = ['bounded-run', 'agentkit-run', 'portable-tool', 'agent-session', 'review-gate', 'review-profile'];
      for (const tool of goneTools) {
        expectMissing(join(home, '.local', 'bin', tool));
      }
      for (const gone of [
        join(home, '.claude', 'hooks'),
        join(home, '.claude', 'tools'),
        join(home, '.claude', 'skills', 'sample'),
        join(home, '.grok', 'skills', 'sample'),
        join(home, '.agents', 'skills', 'sample'),
        join(home, '.grok', 'rules', 'sample-prompt.md'),
        join(home, '.agents', 'instructions', 'sample-prompt.md'),
        join(home, '.config', 'opencode', 'plugins', 'sample-plugin.ts'),
        join(home, '.codex', 'prompts', 'sample.md'),
        join(home, '.codex', 'rules', 'sample-police.rules'),
        join(home, '.codex', 'rules', 'other-police.rules'),
        join(home, '.codex', 'hooks', 'review-police.sh'),
        join(home, '.codex', 'tools', 'review-gate'),
        join(home, '.config', 'systemd', 'user', 'agent-sessions.slice'),
        join(home, '.local', 'share', 'agentkit'),
      ]) {
        expectMissing(gone);
      }
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).not.toContain(
        'developer_instructions',
      );

      const finalSettings = readFileSync(settingsPath, 'utf-8');
      expect(finalSettings).toContain('/opt/mine/my-own-hook.sh');
      expect(finalSettings).not.toContain('git-police.sh');
      expect(finalSettings).not.toContain('update-notice.sh');
      expect(JSON.parse(finalSettings).model).toBe('opus');

      expectUserContentIntact(fixture);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test('keeps the user config by default and removes it with --purge-config', () => {
    const fixture = createFixture();
    const configFile = join(fixture.home, '.config', 'agentkit', 'config.yaml');
    try {
      expect(run(fixture, ['--global', '--no-session-scope']).status).toBe(0);
      writeFileSync(configFile, 'enforcement:\n  mine: true\n');

      const kept = run(fixture, ['--global', '--uninstall']);
      expect(kept.status, kept.stderr).toBe(0);
      expect(existsSync(configFile)).toBe(true);
      expect(readFileSync(configFile, 'utf-8')).toContain('mine: true');
      expect(kept.stdout).toContain('Kept your config');

      const purged = run(fixture, ['--global', '--uninstall', '--purge-config']);
      expect(purged.status, purged.stderr).toBe(0);
      expect(existsSync(configFile)).toBe(false);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test('is idempotent and exits 0 on a system that was never installed to', () => {
    const fixture = createFixture();
    try {
      const clean = run(fixture, ['--global', '--uninstall']);
      expect(clean.status, clean.stderr).toBe(0);
      expect(existsSync(join(fixture.home, '.agentkit'))).toBe(false);

      expect(run(fixture, ['--global', '--no-session-scope']).status).toBe(0);
      expect(run(fixture, ['--global', '--uninstall']).status).toBe(0);

      const second = run(fixture, ['--global', '--uninstall']);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).not.toContain('Removed: ');
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test('rejects --purge-config without --uninstall', () => {
    const fixture = createFixture();
    try {
      const result = run(fixture, ['--global', '--purge-config']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--purge-config only applies to --uninstall');
      expect(existsSync(join(fixture.home, '.agentkit'))).toBe(false);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

describe('install.sh --uninstall (project)', () => {
  test('removes the project install and leaves unrelated project files alone', () => {
    const fixture = createFixture();
    const { target } = fixture;
    try {
      writeFixtureFile(join(target, '.codex', 'rules', 'default.rules'), '# project policy\n');
      writeFixtureFile(join(target, '.claude', 'skills', 'team-skill', 'SKILL.md'), '# Team\n');

      const installed = run(fixture, [target, '--with', 'adversarial-review']);
      expect(installed.status, installed.stderr).toBe(0);
      expect(existsSync(join(target, '.claude', 'hooks', 'git-police.sh'))).toBe(true);
      expect(existsSync(join(target, '.opencode', 'skills', 'sample'))).toBe(true);
      expect(existsSync(join(target, '.claude', 'settings.json'))).toBe(true);

      const removed = run(fixture, ['--uninstall', target]);
      expect(removed.status, removed.stderr).toBe(0);

      for (const gone of [
        join(target, '.opencode'),
        join(target, '.claude', 'hooks'),
        join(target, '.claude', 'tools'),
        join(target, '.claude', 'skills', 'sample'),
        join(target, '.codex', 'rules', 'sample-police.rules'),
        join(target, '.codex', 'hooks'),
        join(target, '.codex', 'hooks.json'),
        // A settings.json holding nothing but agentkit hooks goes with them.
        join(target, '.claude', 'settings.json'),
      ]) {
        expectMissing(gone);
      }

      expect(existsSync(join(target, '.codex', 'rules', 'default.rules'))).toBe(true);
      expect(existsSync(join(target, '.claude', 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
      // A project install writes nothing global; the uninstall must not either.
      expect(readdirSync(fixture.home)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
