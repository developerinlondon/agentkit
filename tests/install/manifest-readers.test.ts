import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { kitHasSkills, kitOf, parseSkillKits, readSkillKits } from '../../scripts/skill-kits';

const repoRoot = dirname(dirname(import.meta.dir));
const fixtures = join(repoRoot, 'tests', 'fixtures');
const hostile = join(fixtures, 'skill-kits-hostile');
const orphan = join(fixtures, 'skill-kits-orphan');
const duplicate = join(fixtures, 'skill-kits-duplicate');
const resurrected = join(fixtures, 'skill-kits-resurrected');
const shipped = join(repoRoot, 'skills', 'KITS');

// The installer and the plugin generator read the manifest in bash; the tests
// and any future picker read it in TypeScript. A disagreement means one of them
// installs or ships a different set of skills than the other believes.
function bashReader(manifest: string, script: string) {
  return spawnSync('bash', ['-c', `source "${join(repoRoot, 'lib', 'skill-kits.sh')}"\n${script}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, SKILL_KITS_FILE: manifest },
  });
}

const probedSkills = [
  'product-intelligence',
  'product-review',
  'plugin',
  'code-quality',
  'kit',
];

// Retirement drives destructive work — deleting state, uninstalling plugins — so
// what counts as retired has to be pinned in both directions, not just the one
// the shipped manifest happens to exercise.
describe('a retired kit name yields to the manifest', () => {
  for (const name of ['review', 'strict-review']) {
    test(`\`${name}\` is retired when the manifest does not declare it`, () => {
      const probe = bashReader(shipped, `kit_name_retired "${name}"`);
      expect(probe.status, probe.stderr).toBe(0);
    });
  }

  test('a manifest that declares the name takes it back', () => {
    const probe = bashReader(resurrected, 'kit_name_retired "strict-review"');
    expect(probe.status).toBe(1);
  });
});

describe('manifest readers agree', () => {
  test('bash and TypeScript resolve the same kits on a hostile manifest', () => {
    const manifest = parseSkillKits(readFileSync(hostile, 'utf-8'));

    const kits = bashReader(hostile, 'declared_kits');
    expect(kits.status, kits.stderr).toBe(0);
    expect(kits.stdout.trim().split('\n')).toEqual(manifest.kits.map((kit) => kit.id));

    for (const kit of manifest.kits) {
      const described = bashReader(hostile, `kit_description "${kit.id}"`);
      expect(described.stdout.replace(/\n$/, ''), `${kit.id} description`).toBe(
        kit.description,
      );
    }

    for (const skill of probedSkills) {
      const resolved = bashReader(hostile, `skill_kit "${skill}"`);
      expect(resolved.stdout, `${skill} kit`).toBe(kitOf(manifest, skill));
    }
  });

  test('both readers reject a membership line that lost its kit', () => {
    const validated = bashReader(orphan, 'validate_skill_kits');
    expect(validated.status).toBe(1);
    expect(validated.stderr).toContain('without a kit');

    expect(() => parseSkillKits(readFileSync(orphan, 'utf-8'))).toThrow(
      'membership record without a kit',
    );
  });

  test('both readers reject a skill claimed by two kits', () => {
    // Accepting it would be worse than divergent: bash resolves first-match and
    // TypeScript last-match, so installer and generator would disagree.
    const validated = bashReader(duplicate, 'validate_skill_kits');
    expect(validated.status).toBe(1);
    expect(validated.stderr).toContain('more than one kit for: product-review');

    expect(() => parseSkillKits(readFileSync(duplicate, 'utf-8'))).toThrow(
      'more than one kit for: product-review',
    );
  });

  test('a skill named after an Object.prototype key behaves like any other name', () => {
    const proto = join(fixtures, 'skill-kits-proto');
    const manifest = parseSkillKits(readFileSync(proto, 'utf-8'));
    expect(manifest.membership['toString']).toBe('product');

    const resolved = bashReader(proto, 'skill_kit "toString"');
    expect(resolved.stdout).toBe(kitOf(manifest, 'toString'));

    // Absent from the manifest entirely, it must fall back to core as a
    // string — never surface an inherited function through the lookup.
    const clean = parseSkillKits(readFileSync(hostile, 'utf-8'));
    expect(kitOf(clean, 'toString')).toBe('core');
    expect(kitOf(clean, 'constructor')).toBe('core');
  });

  test('the shipped manifest passes both readers', () => {
    const validated = bashReader(join(repoRoot, 'skills', 'KITS'), 'validate_skill_kits');
    expect(validated.status, validated.stderr).toBe(0);
    expect(readSkillKits(repoRoot).kits.length).toBeGreaterThan(1);
  });

  // A "no" from either reader is acted on destructively (generation skipped,
  // plugin trees pruned), so both must agree — and both must refuse to call a
  // tree with no skill directories at all "empty".
  test('bash and TypeScript agree on which kits have skills', () => {
    const tree = join(fixtures, 'skill-tree');
    const manifest = readSkillKits(tree);
    for (const [kit, expected] of [['core', true], ['g1', true], ['g2', false]] as const) {
      expect(kitHasSkills(manifest, tree, kit), `ts: ${kit}`).toBe(expected);
      const shell = bashReader(join(tree, 'skills', 'KITS'), `kit_has_skills "${kit}"`);
      expect(shell.status === 0, `bash: ${kit}`).toBe(expected);
    }
  });

  test('a manifest with no skills tree beside it cannot claim every kit is empty', () => {
    const empty = join(fixtures, 'skill-tree-empty');
    const manifest = readSkillKits(empty);
    for (const kit of ['g1', 'g2']) {
      expect(kitHasSkills(manifest, empty, kit), `ts: ${kit}`).toBe(true);
      const shell = bashReader(join(empty, 'skills', 'KITS'), `kit_has_skills "${kit}"`);
      expect(shell.status, `bash: ${kit}`).toBe(0);
    }
  });
});
