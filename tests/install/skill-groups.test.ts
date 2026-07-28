import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSkillGroups, skillsInGroup } from '../../scripts/skill-groups';

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

  test('--all installs every declared group', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-groups-'));

    try {
      const result = install(home, ['--all']);
      expect(result.status, result.stderr).toBe(0);

      const manifest = readSkillGroups(repoRoot);
      for (const group of manifest.groups) {
        for (const skill of skillsInGroup(manifest, repoRoot, group.id)) {
          expect(existsSync(join(canonSkill(home, skill), 'SKILL.md')), `${skill} installed`).toBe(
            true,
          );
        }
      }
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a later bare install keeps the groups chosen once', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-groups-'));

    try {
      expect(install(home, ['--with', 'product']).status).toBe(0);
      expect(readFileSync(join(home, '.agentkit', 'groups'), 'utf-8')).toContain('product');

      // The automation story: one command forever, no flags to remember.
      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).toContain('Skill groups:    core product');
      expect(existsSync(join(canonSkill(home, 'product-intelligence'), 'SKILL.md'))).toBe(true);
      // Retention is not what carried it: the Codex prompt is regenerated from
      // the selection, and a merely-retained group would not produce one.
      expect(existsSync(join(home, '.codex', 'prompts', 'product-review.md'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('dropping a group from the persisted file stops selecting it', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-groups-'));

    try {
      expect(install(home, ['--with', 'product']).status).toBe(0);
      writeFileSync(join(home, '.agentkit', 'groups'), '');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).toContain('Skill groups:    core\n');
      expect(upgrade.stdout).toContain(
        "[skills] Keeping installed (group 'product' not selected): product-review",
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('the manifest declares every group it uses and names real skills', () => {
    const manifest = readSkillGroups(repoRoot);
    const declared = new Set(manifest.groups.map((group) => group.id));

    expect(declared.has('core')).toBe(true);
    for (const group of manifest.groups) {
      // A wizard and the plugin generator both render this; an empty one ships
      // a plugin with a blank description.
      expect(group.description.length, `${group.id} needs a description`).toBeGreaterThan(0);
    }
    for (const [skill, group] of Object.entries(manifest.membership)) {
      expect(declared.has(group), `${skill} is in undeclared group ${group}`).toBe(true);
      expect(existsSync(join(repoRoot, 'skills', skill, 'SKILL.md')), `${skill} exists`).toBe(true);
    }
  });
});
