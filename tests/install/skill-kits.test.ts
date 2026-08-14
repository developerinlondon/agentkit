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
      // Kit selection is what these pin, not dependency fetching. The real
      // bun-install path is exercised once, by the first test in
      // tests/install-prompt.test.ts.
      AGENTKIT_SKIP_SKILL_DEPS: '1',
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
  test('an install never copies a source dependency tree', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));
    const sourceModules = join(repoRoot, 'skills', 'autonomous-workflow', 'node_modules');

    try {
      expect(existsSync(sourceModules)).toBe(false);
      mkdirSync(sourceModules);
      writeFileSync(join(sourceModules, 'source-only.txt'), 'must not be installed\n');

      const result = install(home);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(canonSkill(home, 'autonomous-workflow'), 'node_modules'))).toBe(false);
    } finally {
      rmSync(sourceModules, { force: true, recursive: true });
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

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

  test('an upgrade removes a product skill that is no longer selected', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      // Someone who installed before kit selection has this without a recorded
      // opt-in. Presence is not a selection: leaving it discoverable keeps the
      // optional workflow active.
      const installed = canonSkill(home, 'product-review');
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'SKILL.md'), '# stale\n');

      const result = install(home);
      expect(result.status, result.stderr).toBe(0);

      expect(existsSync(installed)).toBe(false);
      expect(result.stdout).toContain(
        "[skills] Removing (kit 'product' not selected): product-review",
      );
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

  // A tracker-specific kit must cost nothing to anyone who does not use that
  // tracker: the skill file never lands unless the kit is asked for by name.
  test('the clickup kit stays out of a default install and lands with --with', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      expect(install(home).status).toBe(0);
      expect(existsSync(canonSkill(home, 'clickup-task-lifecycle'))).toBe(false);

      expect(install(home, ['--with', 'clickup']).status).toBe(0);
      expect(existsSync(join(canonSkill(home, 'clickup-task-lifecycle'), 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  // Membership is what withholds a skill. A kit declaration with no `<skill> <kit>`
  // record leaves the skill in core, where it installs for everyone — which is
  // indistinguishable from a working opt-in kit unless the default install is
  // asserted to be empty of it.
  test('the workspace kit stays out of a default install and lands with --with', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));
    const skills = ['huly-work-item-lifecycle', 'workspace-diagrams'];

    try {
      expect(install(home).status).toBe(0);
      for (const skill of skills) {
        expect(existsSync(canonSkill(home, skill)), `${skill} withheld by default`).toBe(false);
      }

      expect(install(home, ['--with', 'workspace']).status).toBe(0);
      for (const skill of skills) {
        expect(existsSync(join(canonSkill(home, skill), 'SKILL.md')), skill).toBe(true);
      }
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);

  // The manifest is the assertion the install test cannot make on its own: a
  // skill named by no membership line reads as core, and core is every install.
  test('every workspace skill is recorded in the workspace kit, not in core', () => {
    const manifest = readSkillKits(repoRoot);
    const workspace = manifest.kits.find((kit) => kit.id === 'workspace');

    expect(workspace, 'workspace kit declared').toBeDefined();
    expect(workspace?.explicit, 'workspace is opt-in, not consent-gated').toBe(false);
    expect(skillsInKit(manifest, repoRoot, 'workspace').sort()).toEqual([
      'huly-work-item-lifecycle',
      'workspace-diagrams',
    ]);
    expect(skillsInKit(manifest, repoRoot, 'core')).not.toContain('huly-work-item-lifecycle');
    expect(skillsInKit(manifest, repoRoot, 'core')).not.toContain('workspace-diagrams');
  });

  test('the marketing kit stays out of a default install and lands with --with', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      expect(install(home).status).toBe(0);
      expect(existsSync(canonSkill(home, 'content-creator')), 'withheld by default').toBe(false);

      expect(install(home, ['--with', 'marketing']).status).toBe(0);
      expect(existsSync(join(canonSkill(home, 'content-creator'), 'SKILL.md'))).toBe(true);
      // The references carry the procedures SKILL.md defers to. Installing the
      // entry point without them leaves the skill citing files that are not there.
      expect(
        existsSync(join(canonSkill(home, 'content-creator'), 'references', 'voice-guide.md')),
        'voice-guide reference installed',
      ).toBe(true);
      expect(
        existsSync(join(canonSkill(home, 'content-creator'), 'references', 'repurposing.md')),
        'repurposing reference installed',
      ).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);

  test('content-creator is recorded in the marketing kit, not in core', () => {
    const manifest = readSkillKits(repoRoot);
    const marketing = manifest.kits.find((kit) => kit.id === 'marketing');

    expect(marketing, 'marketing kit declared').toBeDefined();
    expect(marketing?.explicit, 'marketing is opt-in, not consent-gated').toBe(false);
    expect(skillsInKit(manifest, repoRoot, 'marketing').sort()).toEqual(['content-creator']);
    expect(skillsInKit(manifest, repoRoot, 'core')).not.toContain('content-creator');
  });

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
  // carries the selection over and then clears the old file. Deleting it unread
  // would read as "nothing selected", and an unselected explicit kit is REMOVED —
  // an upgrade would silently uninstall a merge gate somebody opted into.
  test('a retired groups file carries its selection over, under the current kit name', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      mkdirSync(join(home, '.agentkit'), { recursive: true });
      // As a v0.5.1 install recorded it: the gate under its old name, beside a
      // kit whose name never changed.
      writeFileSync(join(home, '.agentkit', 'groups'), '# chosen once\nstrict-review\nproduct\n');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(existsSync(join(home, '.agentkit', 'groups'))).toBe(false);

      const kits = readFileSync(join(home, '.agentkit', 'kits'), 'utf-8');
      expect(kits).toContain('adversarial-review');
      expect(kits).toContain('product');
      expect(kits).not.toContain('strict-review');

      // The gate survives the upgrade, artifacts and all.
      expect(existsSync(join(canonSkill(home, 'adversarial-review'), 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.agentkit', 'tools', 'review-gate'))).toBe(true);
      expect(existsSync(canonSkill(home, 'product-intelligence'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);

  // The state-file header invites hand-editing, and editors drop final newlines.
  // `read` returns nonzero on an unterminated last line, so without the loop's
  // `|| [[ -n ]]` tail that line vanishes — and a vanished explicit kit is an
  // uninstalled merge gate.
  test('a groups file without a trailing newline still carries its last kit', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      mkdirSync(join(home, '.agentkit'), { recursive: true });
      writeFileSync(join(home, '.agentkit', 'groups'), 'strict-review');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(readFileSync(join(home, '.agentkit', 'kits'), 'utf-8')).toContain('adversarial-review');
      expect(existsSync(join(home, '.agentkit', 'tools', 'review-gate'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);

  // Both files present means an older installer ran after a newer one. The
  // newer writer wins, the notice says so, and the retired file goes — but the
  // kits file it defers to is not touched.
  test('a groups file beside a kits file is retired without touching the selection', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      mkdirSync(join(home, '.agentkit'), { recursive: true });
      writeFileSync(join(home, '.agentkit', 'groups'), 'strict-review\n');
      writeFileSync(join(home, '.agentkit', 'kits'), 'product\n');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(existsSync(join(home, '.agentkit', 'groups'))).toBe(false);
      expect(upgrade.stderr).toContain('already records the selection');
      expect(upgrade.stdout).toContain('Skill kits:    core product');
      expect(existsSync(canonSkill(home, 'adversarial-review'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  // An entry that is neither a current kit nor a retired name must not survive
  // the carry-over as a selection.
  test('an unknown name in the retired file is dropped, not carried over', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      mkdirSync(join(home, '.agentkit'), { recursive: true });
      writeFileSync(join(home, '.agentkit', 'groups'), 'no-such-kit\n');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(readFileSync(join(home, '.agentkit', 'kits'), 'utf-8')).not.toContain('no-such-kit');
      expect(upgrade.stdout).toContain('Skill kits:    core');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  // The kits file is the one the header tells users to keep editing, so its
  // reader needs the same unterminated-last-line guard as the carry-over.
  test('a kits file without a trailing newline still selects its last kit', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      mkdirSync(join(home, '.agentkit'), { recursive: true });
      writeFileSync(join(home, '.agentkit', 'kits'), 'adversarial-review');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).toContain('Skill kits:    core adversarial-review');
      expect(existsSync(join(home, '.agentkit', 'tools', 'review-gate'))).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);

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
  }, globalInstallTimeoutMs * 2);

  test('dropping kits from the persisted file removes their managed artifacts', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-kits-'));

    try {
      expect(install(home, ['--with', 'product', '--with', 'brain']).status).toBe(0);
      writeFileSync(join(home, '.agentkit', 'kits'), '');

      const upgrade = install(home);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).toContain('Skill kits:    core\n');
      expect(existsSync(canonSkill(home, 'product-review'))).toBe(false);
      expect(existsSync(canonSkill(home, 'reflect'))).toBe(false);
      expect(existsSync(join(home, '.codex', 'prompts', 'product-review.md'))).toBe(false);
      expect(existsSync(join(home, '.claude', 'hooks', 'memory-inject.sh'))).toBe(false);
      expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).not.toContain(
        'memory-inject.sh',
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);

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
      const userSkill = join(home, '.claude', 'skills', 'user-owned');
      mkdirSync(userSkill, { recursive: true });
      writeFileSync(join(userSkill, 'SKILL.md'), '# user owned\n');

      const dropped = install(home, ['--without', 'product']);
      expect(dropped.status, dropped.stderr).toBe(0);
      expect(dropped.stdout).toContain('Skill kits:    core\n');
      expect(readFileSync(join(home, '.agentkit', 'kits'), 'utf-8')).not.toContain('product');

      expect(dropped.stdout).toContain(
        "[skills] Removing (kit 'product' not selected): product-review",
      );
      expect(existsSync(canonSkill(home, 'product-review'))).toBe(false);
      expect(existsSync(join(home, '.claude', 'skills', 'product-review'))).toBe(false);
      expect(existsSync(join(home, '.codex', 'prompts', 'product-review.md'))).toBe(false);
      expect(existsSync(join(canonSkill(home, 'code-quality'), 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(userSkill, 'SKILL.md'), 'utf-8')).toBe('# user owned\n');
      // It sticks: the next bare upgrade does not resurrect it.
      const after = install(home);
      expect(after.stdout).toContain('Skill kits:    core\n');
      expect(existsSync(canonSkill(home, 'product-review'))).toBe(false);
      expect(readFileSync(join(home, '.agentkit', 'kits'), 'utf-8')).toContain(
        'removes that kit on the next install',
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 3);

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
