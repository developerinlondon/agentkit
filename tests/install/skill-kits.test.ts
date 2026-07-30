import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSkillKits, skillsInKit } from '../../scripts/skill-kits';

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

describe('skill kit selection', () => {
  test('a default install ships core skills and leaves the product kit out', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      const result = install(home);
      expect(result.status, result.stderr).toBe(0);

      expect(existsSync(join(canonSkill(home, 'code-quality'), 'SKILL.md'))).toBe(true);
      for (const name of ['product-intelligence', 'product-review']) {
        expect(existsSync(canonSkill(home, name)), `${name} must not install by default`).toBe(
          false,
        );
        // Clients are linked from the canonical tree, and Codex renders each
        // skill as a prompt — an unselected kit must reach neither.
        expect(existsSync(join(home, '.claude', 'skills', name))).toBe(false);
        expect(existsSync(join(home, '.grok', 'skills', name))).toBe(false);
        expect(existsSync(join(home, '.codex', 'prompts', `${name}.md`))).toBe(false);
      }
      expect(result.stdout).toContain('Skill kits:    core');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('--with product adds the opt-in kit to every client', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      const result = install(home, ['--with', 'product']);
      expect(result.status, result.stderr).toBe(0);

      for (const name of ['product-intelligence', 'product-review']) {
        expect(existsSync(join(canonSkill(home, name), 'SKILL.md'))).toBe(true);
        expect(existsSync(join(home, '.claude', 'skills', name))).toBe(true);
        expect(existsSync(join(home, '.codex', 'prompts', `${name}.md`))).toBe(true);
      }
      expect(existsSync(join(canonSkill(home, 'code-quality'), 'SKILL.md'))).toBe(true);
      expect(result.stdout).toContain('Skill kits:    core product');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('an upgrade keeps and refreshes an already-installed product skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

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
        "[skills] Keeping installed (kit 'product' not selected): product-review",
      );
      // Retention is per-skill: the one that was never installed stays out.
      expect(existsSync(canonSkill(home, 'product-intelligence'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('an undeclared kit fails the install instead of silently installing nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      const result = install(home, ['--with', 'produkt']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unknown skill kit 'produkt'");
      expect(existsSync(join(home, '.agentkit', 'skills'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('--all installs every non-explicit kit and withholds explicit ones', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      const result = install(home, ['--all']);
      expect(result.status, result.stderr).toBe(0);

      const manifest = readSkillKits(repoRoot);
      for (const kit of manifest.kits) {
        for (const skill of skillsInKit(manifest, repoRoot, kit.id)) {
          expect(
            existsSync(join(canonSkill(home, skill), 'SKILL.md')),
            `${skill} ${kit.explicit ? 'withheld' : 'installed'}`,
          ).toBe(!kit.explicit);
        }
      }
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a literal --with installs an explicit kit; deselecting it removes the skills', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      expect(install(home, ['--with', 'adversarial-review']).status).toBe(0);
      expect(existsSync(join(canonSkill(home, 'adversarial-review'), 'SKILL.md'))).toBe(true);

      expect(install(home, ['--without', 'adversarial-review']).status).toBe(0);
      expect(existsSync(canonSkill(home, 'adversarial-review'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);

  // Installs exist on several machines, so the run that renames the state file
  // has to clear the old one itself — a leftover `groups` file is a file nobody
  // reads, sitting next to the one that decides what is installed.
  test('a retired groups state file is removed, and says the selection is not inherited', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      mkdirSync(join(home, '.agentkit'), { recursive: true });
      writeFileSync(join(home, '.agentkit', 'groups'), '# chosen once\nproduct\n');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(existsSync(join(home, '.agentkit', 'groups'))).toBe(false);
      expect(upgrade.stderr).toContain('Removed retired');
      expect(upgrade.stderr).toContain('re-add with --with');
      // Not inherited: the old file's `product` does not select anything.
      expect(upgrade.stdout).toContain('Skill kits:    core');
      expect(existsSync(canonSkill(home, 'product-intelligence'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a later bare install keeps the kits chosen once', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      expect(install(home, ['--with', 'product']).status).toBe(0);
      expect(readFileSync(join(home, '.agentkit', 'kits'), 'utf-8')).toContain('product');

      // Stands in for a skill added to the kit upstream: it is NOT installed
      // when the upgrade runs, so retention cannot bring it back — only the
      // persisted selection can.
      rmSync(canonSkill(home, 'product-intelligence'), { force: true, recursive: true });

      // The automation story: one command forever, no flags to remember.
      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).toContain('Skill kits:    core product');
      expect(existsSync(join(canonSkill(home, 'product-intelligence'), 'SKILL.md'))).toBe(true);
      // Retention is not what carried it: the Codex prompt is regenerated from
      // the selection, and a merely-retained kit would not produce one.
      expect(existsSync(join(home, '.codex', 'prompts', 'product-review.md'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('dropping a kit from the persisted file stops selecting it', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      expect(install(home, ['--with', 'product']).status).toBe(0);
      writeFileSync(join(home, '.agentkit', 'kits'), '');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).toContain('Skill kits:    core\n');
      expect(upgrade.stdout).toContain(
        "[skills] Keeping installed (kit 'product' not selected): product-review",
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('an unknown flag fails with usage instead of becoming the target directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      for (const flag of ['--bogus', '-x', '--all-the-things']) {
        const result = install(home, [flag]);
        // Swallowed as TARGET_DIR, a typo'd flag makes the installer silently
        // do something other than what was asked for.
        expect(result.status, `${flag} must be rejected`).toBe(2);
        expect(result.stderr).toContain(`unknown option '${flag}'`);
        // The diagnostic and the usage it refers to belong on the same stream.
        expect(result.stderr).toContain('Usage: ./install.sh');
        expect(result.stdout).not.toContain('Usage: ./install.sh');
      }
      expect(existsSync(join(home, '.agentkit', 'skills'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a repeated kit is selected once', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      const result = install(home, ['--with', 'product', '--with=product']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Skill kits:    core product\n');
      expect(readFileSync(join(home, '.agentkit', 'kits'), 'utf-8').match(/^product$/gm))
        .toHaveLength(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a stale kit in the persisted file is skipped, not fatal', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      mkdirSync(join(home, '.agentkit'), { recursive: true });
      // Last-line position matters: as the read loop's tail, an undeclared
      // entry used to decide the loop's exit status and kill the install.
      writeFileSync(join(home, '.agentkit', 'kits'), 'product\nlegacy-gone\n');

      const result = install(home);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stderr).toContain('Ignoring unknown kit');
      expect(result.stderr).toContain('legacy-gone');
      // The valid entry on the earlier line still selects its kit.
      expect(result.stdout).toContain('Skill kits:    core product');
      expect(existsSync(join(canonSkill(home, 'product-review'), 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('--without drops a kit from the selection and the remembered set', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      expect(install(home, ['--with', 'product']).status).toBe(0);

      const dropped = install(home, ['--without', 'product']);
      expect(dropped.status, dropped.stderr).toBe(0);
      expect(dropped.stdout).toContain('Skill kits:    core\n');
      expect(readFileSync(join(home, '.agentkit', 'kits'), 'utf-8')).not.toContain('product');

      // Deselection changes what is chosen, never what is on disk: the
      // installer removes nothing it previously installed.
      expect(dropped.stdout).toContain(
        "[skills] Keeping installed (kit 'product' not selected): product-review",
      );
      // It sticks: the next bare upgrade does not resurrect it.
      const after = install(home);
      expect(after.stdout).toContain('Skill kits:    core\n');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('--without core is refused', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      const result = install(home, ['--without', 'core']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('core kit cannot be deselected');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('the manifest declares every kit it uses and names real skills', () => {
    const manifest = readSkillKits(repoRoot);
    const declared = new Set(manifest.kits.map((kit) => kit.id));

    expect(declared.has('core')).toBe(true);
    for (const kit of manifest.kits) {
      // A wizard and the plugin generator both render this; an empty one ships
      // a plugin with a blank description.
      expect(kit.description.length, `${kit.id} needs a description`).toBeGreaterThan(0);
    }
    for (const [skill, kit] of Object.entries(manifest.membership)) {
      expect(declared.has(kit), `${skill} is in undeclared kit ${kit}`).toBe(true);
      expect(existsSync(join(repoRoot, 'skills', skill, 'SKILL.md')), `${skill} exists`).toBe(true);
    }
  });
});
