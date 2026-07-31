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
  for (const lib of ['install-platform.sh', 'skill-kits.sh']) {
    writeFixtureFile(join(repo, 'lib', lib), readFileSync(join(repoRoot, 'lib', lib), 'utf-8'));
  }
  writeFixtureFile(join(repo, 'config.example.yaml'), '{}\n');
  writeFixtureFile(join(repo, 'skills', 'sample', 'SKILL.md'), '# Sample\n');
  writeFixtureFile(
    join(repo, 'skills', 'KITS'),
    'kit core Sample core kit\nkit adversarial-review Sample review kit\nexplicit adversarial-review\n',
  );
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
    [
      '# agentkit:platform linux # local cgroup containment',
      'prefix_rule(',
      '    runner-allow',
      ')',
      '# agentkit:resource-class cargo',
      'prefix_rule(',
      '    cargo-block',
      ')',
      '# tsc orphan comment',
      '# agentkit:resource-class typescript',
      'prefix_rule(',
      '    tsc-block',
      ')',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    join(repo, 'policies', 'codex', 'delegation-police.rules'),
    '# universal delegation policy\n',
  );
  writeFixtureFile(
    join(repo, 'policies', 'codex', 'pkg-police.rules'),
    '# bun-only package policy\n',
  );
  writeFixtureFile(
    join(repo, 'policies', 'codex', 'git-police.rules'),
    '# universal git policy\n',
  );

  return { home, repo, root, target };
}

function writeAgentkitConfig(fixture: Fixture, contents: string): void {
  writeFixtureFile(join(fixture.home, '.config', 'agentkit', 'config.yaml'), contents);
}

const ENFORCEMENT_ON = [
  'resource-police:',
  '  enabled: true',
  'delegation-police:',
  '  enabled: true',
  'pkg-police:',
  '  manager: bun',
  '',
].join('\n');

function runInstall(
  fixture: Fixture,
  platform: string,
  global: boolean,
  disableSessionScope = true,
  withReview = false,
) {
  const args = global
    ? [
        join(fixture.repo, 'install.sh'),
        '--global',
        ...(disableSessionScope ? ['--no-session-scope'] : []),
      ]
    : [join(fixture.repo, 'install.sh'), fixture.target];
  if (withReview) args.push('--with', 'adversarial-review');
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
  expect(existsSync(path), path).toBe(false);
  expect(() => lstatSync(path), path).toThrow();
}

describe('platform-aware artifact installation', () => {
  for (const global of [true, false]) {
    const mode = global ? 'global' : 'project';

    test(`${mode} install includes Linux-only and universal artifacts on Linux`, () => {
      const fixture = createFixture();
      try {
        const result = runInstall(fixture, 'linux', global, true, true);
        expect(result.status, result.stderr).toBe(0);

        const { codex, policies, tools } = installedPaths(fixture, global);
        expect(existsSync(join(tools, 'bounded-run'))).toBe(true);
        expect(lstatSync(join(tools, 'agentkit-run')).isSymbolicLink()).toBe(true);
        expect(existsSync(join(tools, 'portable-tool'))).toBe(true);
        expect(existsSync(join(policies, 'git-police.rules'))).toBe(true);
        expectMissing(join(policies, 'resource-police.rules'));
        expectMissing(join(policies, 'delegation-police.rules'));
        expectMissing(join(policies, 'pkg-police.rules'));
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
        writeAgentkitConfig(fixture, ENFORCEMENT_ON);
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

        const result = runInstall(fixture, 'darwin', global, true, true);
        expect(result.status, result.stderr).toBe(0);

        expectMissing(join(tools, 'bounded-run'));
        expectMissing(join(tools, 'agentkit-run'));
        expect(existsSync(join(tools, 'portable-tool'))).toBe(true);
        expectMissing(join(policies, 'resource-police.rules'));
        expect(existsSync(join(policies, 'delegation-police.rules'))).toBe(true);
        expect(existsSync(join(policies, 'pkg-police.rules'))).toBe(true);
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

    test(`${mode} default install removes review artifacts it never selected`, () => {
      const fixture = createFixture();
      const { codex, tools } = installedPaths(fixture, global);
      const reviewArtifacts = [
        join(tools, 'review-gate'),
        join(tools, 'review-profile'),
        join(codex, 'hooks', 'fail-closed-hook.sh'),
        join(codex, 'hooks', 'review-police.sh'),
        join(codex, 'tools', 'review-gate'),
        join(codex, 'tools', 'review-profile'),
      ];
      if (global) {
        for (const base of [
          join(fixture.home, '.agentkit', 'tools'),
          join(fixture.home, '.claude', 'tools'),
        ]) {
          reviewArtifacts.push(join(base, 'review-gate'), join(base, 'review-profile'));
        }
      }

      try {
        for (const path of reviewArtifacts) writeFixtureFile(path, 'stale\n');
        writeFixtureFile(
          join(codex, 'hooks.json'),
          JSON.stringify({
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [
                    { type: 'command', command: '/tmp/unrelated-policy' },
                    {
                      type: 'command',
                      command:
                        'AGENTKIT_HOOK_TARGET=codex /old/fail-closed-hook.sh 45 /old/review-police.sh',
                    },
                  ],
                },
              ],
            },
          }),
        );

        const result = runInstall(fixture, 'linux', global);
        expect(result.status, result.stderr).toBe(0);

        for (const path of reviewArtifacts) expectMissing(path);
        expect(existsSync(join(tools, 'bounded-run'))).toBe(true);
        expect(existsSync(join(tools, 'portable-tool'))).toBe(true);
        const codexHooks = readFileSync(join(codex, 'hooks.json'), 'utf-8');
        expect(codexHooks).toContain('/tmp/unrelated-policy');
        expect(codexHooks).not.toContain('AGENTKIT_HOOK_TARGET=codex');
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

describe('config-driven Codex enforcement policies', () => {
  test('upgrade removes previously installed enforcement policies and preserves user rules', () => {
    const fixture = createFixture();
    try {
      const { policies } = installedPaths(fixture, true);
      for (const name of [
        'resource-police.rules',
        'delegation-police.rules',
        'pkg-police.rules',
      ]) {
        writeFixtureFile(join(policies, name), 'stale enforcement\n');
      }
      writeFixtureFile(join(policies, 'default.rules'), 'user-owned rules\n');

      const result = runInstall(fixture, 'linux', true);
      expect(result.status, result.stderr).toBe(0);

      expectMissing(join(policies, 'resource-police.rules'));
      expectMissing(join(policies, 'delegation-police.rules'));
      expectMissing(join(policies, 'pkg-police.rules'));
      expect(readFileSync(join(policies, 'default.rules'), 'utf-8')).toBe('user-owned rules\n');
      expect(existsSync(join(policies, 'git-police.rules'))).toBe(true);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test('enabling the config installs enforcement policies, filtered to the bounded classes', () => {
    const fixture = createFixture();
    try {
      writeAgentkitConfig(
        fixture,
        [
          'resource-police:',
          '  enabled: true',
          '  bounded:',
          '    - cargo',
          'delegation-police:',
          '  enabled: true',
          'pkg-police:',
          '  manager: bun',
          '',
        ].join('\n'),
      );

      const result = runInstall(fixture, 'linux', true);
      expect(result.status, result.stderr).toBe(0);

      const { policies } = installedPaths(fixture, true);
      expect(existsSync(join(policies, 'delegation-police.rules'))).toBe(true);
      expect(existsSync(join(policies, 'pkg-police.rules'))).toBe(true);
      const resource = readFileSync(join(policies, 'resource-police.rules'), 'utf-8');
      expect(resource).toContain('runner-allow');
      expect(resource).toContain('cargo-block');
      expect(resource).not.toContain('tsc-block');
      expect(resource).not.toContain('agentkit:resource-class');
      expect(resource).not.toContain('tsc orphan comment');
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test('an empty bounded list installs the policy with no class blocks', () => {
    const fixture = createFixture();
    try {
      writeAgentkitConfig(fixture, 'resource-police:\n  enabled: true\n  bounded: []\n');

      const result = runInstall(fixture, 'linux', true);
      expect(result.status, result.stderr).toBe(0);

      const { policies } = installedPaths(fixture, true);
      const resource = readFileSync(join(policies, 'resource-police.rules'), 'utf-8');
      expect(resource).toContain('runner-allow');
      expect(resource).not.toContain('cargo-block');
      expect(resource).not.toContain('tsc-block');
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test('an enabled resource policy without a bounded list keeps every class', () => {
    const fixture = createFixture();
    try {
      writeAgentkitConfig(fixture, 'resource-police:\n  enabled: true\n');

      const result = runInstall(fixture, 'linux', true);
      expect(result.status, result.stderr).toBe(0);

      const { policies } = installedPaths(fixture, true);
      const resource = readFileSync(join(policies, 'resource-police.rules'), 'utf-8');
      expect(resource).toContain('cargo-block');
      expect(resource).toContain('tsc-block');
      expectMissing(join(policies, 'delegation-police.rules'));
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test('the Codex pkg policy requires an explicitly configured bun manager', () => {
    const fixture = createFixture();
    try {
      writeAgentkitConfig(fixture, 'pkg-police:\n  manager: auto\n');
      const { policies } = installedPaths(fixture, true);
      writeFixtureFile(join(policies, 'pkg-police.rules'), 'stale enforcement\n');

      const result = runInstall(fixture, 'linux', true);
      expect(result.status, result.stderr).toBe(0);
      expectMissing(join(policies, 'pkg-police.rules'));
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
