import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
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

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-platform-install-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const target = join(root, 'project');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(target, { recursive: true });

  copyFileSync(installScript, join(repo, 'install.sh'));
  chmodSync(join(repo, 'install.sh'), 0o755);
  writeFixtureFile(
    join(repo, 'lib', 'install-platform.sh'),
    readFileSync(join(repoRoot, 'lib', 'install-platform.sh'), 'utf-8'),
  );
  writeFixtureFile(join(repo, 'config.example.yaml'), '{}\n');
  writeFixtureFile(join(repo, 'skills', 'sample', 'SKILL.md'), '# Sample\n');
  writeFixtureFile(join(repo, 'skills', 'GROUPS'), '# <skill> <group>\n');
  writeFixtureFile(join(repo, 'rules', 'sample.md'), '# Sample\n');
  mkdirSync(join(repo, 'instructions'), { recursive: true });
  mkdirSync(join(repo, 'plugins'), { recursive: true });
  writeFixtureFile(join(repo, 'hooks', 'claude', 'settings.json'), '{"hooks": {}}\n');
  writeFixtureFile(
    join(repo, 'hooks', 'codex', 'hooks.json'),
    '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"__AGENTKIT_CODEX_HOOKS_ROOT__/fail-closed-hook.sh 45 __AGENTKIT_CODEX_HOOKS_ROOT__/review-police.sh","timeout":60}]}]}}\n',
  );
  writeFixtureFile(join(repo, 'hooks', 'claude', 'fail-closed-hook.sh'), '#!/bin/sh\n', true);
  writeFixtureFile(join(repo, 'hooks', 'claude', 'review-police.sh'), '#!/bin/sh\n', true);
  writeFixtureFile(join(repo, 'hooks', 'claude', 'lib', 'hook-input.sh'), '# helper\n');
  writeFixtureFile(
    join(repo, 'tools', 'bounded-run'),
    '#!/usr/bin/env bash\n# agentkit:platforms linux\nprintf "bounded\\n"\n',
    true,
  );
  writeFixtureFile(
    join(repo, 'tools', 'portable-tool'),
    '#!/usr/bin/env bash\nprintf "portable\\n"\n',
    true,
  );
  writeFixtureFile(join(repo, 'tools', 'review-gate'), '#!/usr/bin/env bash\n', true);
  writeFixtureFile(join(repo, 'tools', 'review-profile'), '#!/usr/bin/env bash\n', true);
  writeFixtureFile(
    join(repo, 'policies', 'codex', 'resource-police.rules'),
    '# agentkit:platform linux # local cgroup containment\n',
  );
  writeFixtureFile(
    join(repo, 'policies', 'codex', 'delegation-police.rules'),
    '# universal delegation policy\n',
  );

  return { home, repo, root, target };
}

function runInstall(
  fixture: Fixture,
  platform: string,
  global: boolean,
  disableSessionScope = true,
) {
  const args = global
    ? [
        join(fixture.repo, 'install.sh'),
        '--global',
        ...(disableSessionScope ? ['--no-session-scope'] : []),
      ]
    : [join(fixture.repo, 'install.sh'), fixture.target];
  return spawnSync('bash', args, {
    cwd: fixture.repo,
    env: {
      ...process.env,
      AGENTKIT_HOME: join(fixture.home, '.agentkit'),
      AGENTKIT_PLATFORM: platform,
      HOME: fixture.home,
      XDG_CONFIG_HOME: join(fixture.home, '.config'),
    },
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

function installedPaths(fixture: Fixture, global: boolean) {
  const tools = global ? join(fixture.home, '.local', 'bin') : join(fixture.target, '.claude', 'tools');
  const policies = global ? join(fixture.home, '.codex', 'rules') : join(fixture.target, '.codex', 'rules');
  const codex = global ? join(fixture.home, '.codex') : join(fixture.target, '.codex');
  return { codex, policies, tools };
}

function expectMissing(path: string): void {
  expect(existsSync(path)).toBe(false);
  expect(() => lstatSync(path)).toThrow();
}

describe('platform-aware artifact installation', () => {
  for (const global of [true, false]) {
    const mode = global ? 'global' : 'project';

    test(`${mode} install includes Linux-only and universal artifacts on Linux`, () => {
      const fixture = createFixture();
      try {
        const result = runInstall(fixture, 'linux', global);
        expect(result.status, result.stderr).toBe(0);

        const { codex, policies, tools } = installedPaths(fixture, global);
        expect(existsSync(join(tools, 'bounded-run'))).toBe(true);
        expect(lstatSync(join(tools, 'agentkit-run')).isSymbolicLink()).toBe(true);
        expect(existsSync(join(tools, 'portable-tool'))).toBe(true);
        expect(existsSync(join(policies, 'resource-police.rules'))).toBe(true);
        expect(existsSync(join(policies, 'delegation-police.rules'))).toBe(true);
        expect(existsSync(join(codex, 'hooks', 'review-police.sh'))).toBe(true);
        expect(existsSync(join(codex, 'hooks', 'fail-closed-hook.sh'))).toBe(true);
        expect(existsSync(join(codex, 'hooks', 'lib', 'hook-input.sh'))).toBe(true);
        expect(existsSync(join(codex, 'tools', 'review-gate'))).toBe(true);
        expect(existsSync(join(codex, 'tools', 'review-profile'))).toBe(true);
        expect(readFileSync(join(codex, 'hooks.json'), 'utf-8')).not.toContain(
          '__AGENTKIT_CODEX_HOOKS_ROOT__',
        );
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    });

    test(`${mode} install removes stale Linux-only artifacts on macOS`, () => {
      const fixture = createFixture();
      try {
        const { codex, policies, tools } = installedPaths(fixture, global);
        for (const path of [
          join(tools, 'bounded-run'),
          join(tools, 'agentkit-run'),
          join(policies, 'resource-police.rules'),
        ]) {
          writeFixtureFile(path, 'stale\n');
        }
        if (global) {
          for (const name of ['bounded-run', 'agentkit-run']) {
            writeFixtureFile(join(fixture.home, '.agentkit', 'tools', name), 'stale\n');
            writeFixtureFile(join(fixture.home, '.claude', 'tools', name), 'stale\n');
          }
        }

        const result = runInstall(fixture, 'darwin', global);
        expect(result.status, result.stderr).toBe(0);

        expectMissing(join(tools, 'bounded-run'));
        expectMissing(join(tools, 'agentkit-run'));
        expect(existsSync(join(tools, 'portable-tool'))).toBe(true);
        expectMissing(join(policies, 'resource-police.rules'));
        expect(existsSync(join(policies, 'delegation-police.rules'))).toBe(true);
        expect(existsSync(join(codex, 'hooks', 'review-police.sh'))).toBe(true);
        expect(existsSync(join(codex, 'tools', 'review-gate'))).toBe(true);
        expect(existsSync(join(codex, 'tools', 'review-profile'))).toBe(true);
        if (global) {
          for (const base of [
            join(fixture.home, '.agentkit', 'tools'),
            join(fixture.home, '.claude', 'tools'),
          ]) {
            expectMissing(join(base, 'bounded-run'));
            expectMissing(join(base, 'agentkit-run'));
          }
        }
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    });
  }

  test('default global install skips Linux session scoping on macOS', () => {
    const fixture = createFixture();
    try {
      const result = runInstall(fixture, 'darwin', true, false);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Session scoping is Linux-only');
      expectMissing(join(fixture.home, '.config', 'systemd', 'user', 'agent-sessions.slice'));
      expectMissing(join(fixture.home, '.bashrc'));
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test('rejects an invalid AGENTKIT_PLATFORM before changing an existing install', () => {
    const fixture = createFixture();
    try {
      const staleRunner = join(fixture.target, '.claude', 'tools', 'bounded-run');
      writeFixtureFile(staleRunner, 'leave-me-alone\n');

      const result = runInstall(fixture, 'Linux', false);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('invalid AGENTKIT_PLATFORM');
      expect(readFileSync(staleRunner, 'utf-8')).toBe('leave-me-alone\n');
      expect(existsSync(join(fixture.target, '.claude', 'tools', 'portable-tool'))).toBe(false);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
