import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectFacts, committedFacts, serialise } from '../../scripts/sync-docs-facts.ts';

let root: string;

function write(relative: string, body: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function skill(name: string, description: string): void {
  write(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-docs-facts-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the docs tables are derived from the tree', () => {
  // This is the drift gate. The previous docs lived in another repository and
  // needed a scheduled job to notice they had gone stale; in-repo docs fail the
  // build instead.
  test('the committed tables match a fresh walk of this repository', () => {
    expect(committedFacts()).toBe(serialise(collectFacts()));
  });

  test('a unit is reported in exactly the mechanisms that implement it', () => {
    write('hooks/claude/alpha-police.sh', '#!/usr/bin/env bash\n');
    write('plugins/alpha-police.ts', 'export {};\n');
    write('policies/codex/alpha-police.rules', 'rule\n');
    write('plugins-cc/agentkit/hooks/alpha-police.sh', '#!/usr/bin/env bash\n');
    write('hooks/claude/beta-police.sh', '#!/usr/bin/env bash\n');
    write('plugins/gamma-police.ts', 'export {};\n');
    write('hooks/claude/not-a-unit.sh', '#!/usr/bin/env bash\n');
    write('skills/GROUPS', 'group core Everyday\n');
    mkdirSync(join(root, 'skills'), { recursive: true });

    const facts = collectFacts(root);

    expect(facts.units).toEqual([
      { name: 'alpha', mechanisms: ['hook', 'plugin', 'codexPolicy', 'claudePlugin'] },
      { name: 'beta', mechanisms: ['hook'] },
      { name: 'gamma', mechanisms: ['plugin'] },
    ]);
  });

  test('an explicit group marks every skill inside it, so no page can imply it is a default', () => {
    write(
      'skills/GROUPS',
      [
        'group core Everyday skills',
        'group locked Consent-gated lane',
        'explicit locked',
        '',
        'guarded locked',
      ].join('\n'),
    );
    skill('guarded', 'Only with an explicit opt-in.');
    skill('ordinary', 'Always installed.');

    const facts = collectFacts(root);

    expect(facts.groups).toEqual([
      { id: 'core', description: 'Everyday skills', explicit: false },
      { id: 'locked', description: 'Consent-gated lane', explicit: true },
    ]);
    expect(facts.skills).toEqual([
      {
        name: 'guarded',
        group: 'locked',
        explicit: true,
        description: 'Only with an explicit opt-in.',
      },
      {
        name: 'ordinary',
        group: 'core',
        explicit: false,
        description: 'Always installed.',
      },
    ]);
  });

  test('a skill with no group record belongs to core', () => {
    write('skills/GROUPS', 'group core Everyday skills\n');
    skill('unassigned', 'No group line anywhere.');

    expect(collectFacts(root).skills[0]?.group).toBe('core');
  });

  test('a comment line never becomes a group', () => {
    write('skills/GROUPS', '# group ghost Should not exist\ngroup core Everyday skills\n');

    expect(collectFacts(root).groups.map((group) => group.id)).toEqual(['core']);
  });

  // A missing description used to be publishable as an empty table cell. It has
  // to stop the build instead: a blank cell reads as "no description", not as
  // "the generator could not find one".
  test('a skill without a description is a loud failure', () => {
    write('skills/GROUPS', 'group core Everyday skills\n');
    write('skills/broken/SKILL.md', '---\nname: broken\n---\n');

    expect(() => collectFacts(root)).toThrow('no description');
  });

  test('a skill without frontmatter is a loud failure', () => {
    write('skills/GROUPS', 'group core Everyday skills\n');
    write('skills/broken/SKILL.md', '# broken\n');

    expect(() => collectFacts(root)).toThrow('no frontmatter');
  });
});
