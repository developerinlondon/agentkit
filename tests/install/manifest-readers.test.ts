import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { groupOf, parseSkillGroups, readSkillGroups } from '../../scripts/skill-groups';

const repoRoot = dirname(dirname(import.meta.dir));
const fixtures = join(repoRoot, 'tests', 'fixtures');
const hostile = join(fixtures, 'skill-groups-hostile');
const orphan = join(fixtures, 'skill-groups-orphan');
const duplicate = join(fixtures, 'skill-groups-duplicate');

// The installer and the plugin generator read the manifest in bash; the tests
// and any future picker read it in TypeScript. A disagreement means one of them
// installs or ships a different set of skills than the other believes.
function bashReader(manifest: string, script: string) {
  return spawnSync('bash', ['-c', `source "${join(repoRoot, 'lib', 'skill-groups.sh')}"\n${script}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, SKILL_GROUPS_FILE: manifest },
  });
}

const probedSkills = [
  'product-intelligence',
  'product-review',
  'plugin',
  'code-quality',
  'group',
];

describe('manifest readers agree', () => {
  test('bash and TypeScript resolve the same groups on a hostile manifest', () => {
    const manifest = parseSkillGroups(readFileSync(hostile, 'utf-8'));

    const groups = bashReader(hostile, 'declared_groups');
    expect(groups.status, groups.stderr).toBe(0);
    expect(groups.stdout.trim().split('\n')).toEqual(manifest.groups.map((group) => group.id));

    for (const group of manifest.groups) {
      const described = bashReader(hostile, `group_description "${group.id}"`);
      expect(described.stdout.replace(/\n$/, ''), `${group.id} description`).toBe(
        group.description,
      );
    }

    for (const skill of probedSkills) {
      const resolved = bashReader(hostile, `skill_group "${skill}"`);
      expect(resolved.stdout, `${skill} group`).toBe(groupOf(manifest, skill));
    }
  });

  test('both readers reject a membership line that lost its group', () => {
    const validated = bashReader(orphan, 'validate_skill_groups');
    expect(validated.status).toBe(1);
    expect(validated.stderr).toContain('without a group');

    expect(() => parseSkillGroups(readFileSync(orphan, 'utf-8'))).toThrow(
      'membership record without a group',
    );
  });

  test('both readers reject a skill claimed by two groups', () => {
    // Accepting it would be worse than divergent: bash resolves first-match and
    // TypeScript last-match, so installer and generator would disagree.
    const validated = bashReader(duplicate, 'validate_skill_groups');
    expect(validated.status).toBe(1);
    expect(validated.stderr).toContain('more than one group for: product-review');

    expect(() => parseSkillGroups(readFileSync(duplicate, 'utf-8'))).toThrow(
      'more than one group for: product-review',
    );
  });

  test('a skill named after an Object.prototype key behaves like any other name', () => {
    const proto = join(fixtures, 'skill-groups-proto');
    const manifest = parseSkillGroups(readFileSync(proto, 'utf-8'));
    expect(manifest.membership['toString']).toBe('product');

    const resolved = bashReader(proto, 'skill_group "toString"');
    expect(resolved.stdout).toBe(groupOf(manifest, 'toString'));

    // Absent from the manifest entirely, it must fall back to core as a
    // string — never surface an inherited function through the lookup.
    const clean = parseSkillGroups(readFileSync(hostile, 'utf-8'));
    expect(groupOf(clean, 'toString')).toBe('core');
    expect(groupOf(clean, 'constructor')).toBe('core');
  });

  test('the shipped manifest passes both readers', () => {
    const validated = bashReader(join(repoRoot, 'skills', 'GROUPS'), 'validate_skill_groups');
    expect(validated.status, validated.stderr).toBe(0);
    expect(readSkillGroups(repoRoot).groups.length).toBeGreaterThan(1);
  });
});
