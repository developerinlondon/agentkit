import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { groupOf, parseSkillGroups, readSkillGroups } from '../../scripts/skill-groups';

const repoRoot = dirname(dirname(import.meta.dir));
const fixtures = join(repoRoot, 'tests', 'fixtures');
const hostile = join(fixtures, 'skill-groups-hostile');
const orphan = join(fixtures, 'skill-groups-orphan');

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

  test('the shipped manifest passes both readers', () => {
    const validated = bashReader(join(repoRoot, 'skills', 'GROUPS'), 'validate_skill_groups');
    expect(validated.status, validated.stderr).toBe(0);
    expect(readSkillGroups(repoRoot).groups.length).toBeGreaterThan(1);
  });
});
