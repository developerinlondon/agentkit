import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(import.meta.dir));
const installScript = join(repoRoot, 'install.sh');
// A global install intentionally installs and builds dependency-bearing skills.
const globalInstallTimeoutMs = 60_000;

function install(home: string, extraArgs: string[] = []) {
  return spawnSync('bash', [installScript, '--global', '--no-session-scope', ...extraArgs], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTKIT_PLATFORM: 'linux',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      AGENTKIT_HOME: join(home, '.agentkit'),
      CODEX_HOME: join(home, '.codex'),
    },
    encoding: 'utf-8',
    timeout: globalInstallTimeoutMs,
  });
}

function canonSkill(home: string, name: string) {
  return join(home, '.agentkit', 'skills', name);
}

describe('skill group selection', () => {
  test('a default install ships core skills and leaves the product group out', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-groups-'));

    try {
      const result = install(home);
      expect(result.status, result.stderr).toBe(0);

      expect(existsSync(join(canonSkill(home, 'code-quality'), 'SKILL.md'))).toBe(true);
      for (const name of ['product-intelligence', 'product-review']) {
        expect(existsSync(canonSkill(home, name)), `${name} must not install by default`).toBe(
          false,
        );
        // Clients are linked from the canonical tree, and Codex renders each
        // skill as a prompt — an unselected group must reach neither.
        expect(existsSync(join(home, '.claude', 'skills', name))).toBe(false);
        expect(existsSync(join(home, '.grok', 'skills', name))).toBe(false);
        expect(existsSync(join(home, '.codex', 'prompts', `${name}.md`))).toBe(false);
      }
      expect(result.stdout).toContain('Skill groups:    core');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('--with product adds the opt-in group to every client', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-groups-'));

    try {
      const result = install(home, ['--with', 'product']);
      expect(result.status, result.stderr).toBe(0);

      for (const name of ['product-intelligence', 'product-review']) {
        expect(existsSync(join(canonSkill(home, name), 'SKILL.md'))).toBe(true);
        expect(existsSync(join(home, '.claude', 'skills', name))).toBe(true);
        expect(existsSync(join(home, '.codex', 'prompts', `${name}.md`))).toBe(true);
      }
      expect(existsSync(join(canonSkill(home, 'code-quality'), 'SKILL.md'))).toBe(true);
      expect(result.stdout).toContain('Skill groups:    core product');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('an upgrade keeps and refreshes an already-installed product skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-groups-'));

    try {
      // Someone who installed before the split has these; taking them away on
      // upgrade — or leaving them frozen at the old content — is a regression.
      const installed = canonSkill(home, 'product-review');
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'SKILL.md'), '# stale\n');

      const result = install(home);
      expect(result.status, result.stderr).toBe(0);

      expect(readFileSync(join(installed, 'SKILL.md'), 'utf-8')).toBe(
        readFileSync(join(repoRoot, 'skills', 'product-review', 'SKILL.md'), 'utf-8'),
      );
      expect(result.stdout).toContain(
        "[skills] Keeping installed (group 'product' not selected): product-review",
      );
      // Retention is per-skill: the one that was never installed stays out.
      expect(existsSync(canonSkill(home, 'product-intelligence'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('an undeclared group fails the install instead of silently installing nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-groups-'));

    try {
      const result = install(home, ['--with', 'produkt']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unknown skill group 'produkt'");
      expect(existsSync(join(home, '.agentkit', 'skills'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('every group named in skills/GROUPS refers to a skill that exists', () => {
    const manifest = readFileSync(join(repoRoot, 'skills', 'GROUPS'), 'utf-8');
    const entries = manifest
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.trim().split(/\s+/));

    expect(entries.length).toBeGreaterThan(0);
    for (const [name, group] of entries) {
      expect(group, `${name} needs a group`).toBeTruthy();
      expect(existsSync(join(repoRoot, 'skills', name!, 'SKILL.md')), `${name} exists`).toBe(true);
    }
  });
});
