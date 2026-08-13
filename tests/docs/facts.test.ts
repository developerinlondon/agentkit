import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  collectFacts,
  collectWiring,
  committedFacts,
  pluginHookDrift,
  serialise,
  spliceReadme,
} from '../../scripts/sync-docs-facts.ts';

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

describe('the packaged hooks match their source', () => {
  test('this repository has no drift between a hook and its plugin copy', () => {
    expect(pluginHookDrift()).toEqual([]);
  });

  test('an edited plugin copy is reported', () => {
    write('hooks/claude/alpha-police.sh', '#!/usr/bin/env bash\necho source\n');
    write('plugins-cc/agentkit/hooks/alpha-police.sh', '#!/usr/bin/env bash\necho edited\n');

    expect(pluginHookDrift(root)).toEqual(['agentkit/alpha-police.sh']);
  });

  test('an identical plugin copy is not reported', () => {
    const body = '#!/usr/bin/env bash\necho same\n';
    write('hooks/claude/alpha-police.sh', body);
    write('plugins-cc/agentkit/hooks/alpha-police.sh', body);

    expect(pluginHookDrift(root)).toEqual([]);
  });

  test('a packaged hook with no source is reported rather than ignored', () => {
    write('plugins-cc/agentkit/hooks/ghost-police.sh', '#!/usr/bin/env bash\n');

    expect(pluginHookDrift(root)).toEqual(['agentkit/ghost-police.sh (no hooks/claude source)']);
  });
});

describe('the skill and kit tables come from skills/KITS', () => {
  test('an explicit kit marks every skill inside it, so no page can imply it is a default', () => {
    write(
      'skills/KITS',
      [
        'kit core Everyday skills',
        'kit locked Consent-gated lane',
        'explicit locked',
        '',
        'guarded locked',
      ].join('\n'),
    );
    skill('guarded', 'Only with an explicit opt-in.');
    skill('ordinary', 'Always installed.');

    const facts = collectFacts(root);

    expect(facts.kits).toEqual([
      { id: 'core', description: 'Everyday skills', explicit: false },
      { id: 'locked', description: 'Consent-gated lane', explicit: true },
    ]);
    expect(facts.skills).toEqual([
      {
        name: 'guarded',
        kit: 'locked',
        explicit: true,
        description: 'Only with an explicit opt-in.',
      },
      {
        name: 'ordinary',
        kit: 'core',
        explicit: false,
        description: 'Always installed.',
      },
    ]);
  });

  test('a skill with no kit record belongs to core', () => {
    write('skills/KITS', 'kit core Everyday skills\n');
    skill('unassigned', 'No kit line anywhere.');

    expect(collectFacts(root).skills[0]?.kit).toBe('core');
  });

  test('a comment line never becomes a kit', () => {
    write('skills/KITS', '# kit ghost Should not exist\nkit core Everyday skills\n');

    expect(collectFacts(root).kits.map((kit) => kit.id)).toEqual(['core']);
  });

  // Pins the contract rather than the current guard: today the tokenizer keeps
  // `#` as the first field, so a comment cannot become a record even without the
  // skip. A reader rewritten to strip comment markers instead would assign from
  // the prose that documents the format, and this is what would catch it.
  test('a commented-out membership never assigns a skill', () => {
    write(
      'skills/KITS',
      [
        '# <skill> <kit> puts a skill in a declared kit',
        '# guarded locked',
        'kit core Everyday skills',
        'kit locked Consent-gated lane',
        'explicit locked',
      ].join('\n'),
    );
    skill('guarded', 'Should not be in the locked kit.');

    const guarded = collectFacts(root).skills.find((entry) => entry.name === 'guarded');

    expect(guarded?.kit).toBe('core');
    expect(guarded?.explicit).toBe(false);
  });

  // A missing description used to be publishable as an empty table cell. It has
  // to stop the build instead: a blank cell reads as "no description", not as
  // "the generator could not find one".
  test('a skill without a description is a loud failure', () => {
    write('skills/KITS', 'kit core Everyday skills\n');
    write('skills/broken/SKILL.md', '---\nname: broken\n---\n');

    expect(() => collectFacts(root)).toThrow('no description');
  });

  test('a skill without frontmatter is a loud failure', () => {
    write('skills/KITS', 'kit core Everyday skills\n');
    write('skills/broken/SKILL.md', '# broken\n');

    expect(() => collectFacts(root)).toThrow('no frontmatter');
  });
});

describe('the wiring table comes from the harness settings', () => {
  // The interesting fact about this unit is not that it exists but that it runs
  // behind fail-closed-hook.sh: if the gate cannot answer, the merge is denied
  // rather than allowed. A page that omitted the budget would describe a guard
  // that silently passes on timeout.
  test('the review gate is wired fail-closed on every matcher it claims', () => {
    const review = collectWiring().filter((entry) => entry.unit === 'review');

    expect(review.length).toBeGreaterThan(0);
    for (const entry of review) {
      expect(entry.failClosedBudget).toBeGreaterThan(0);
      expect(entry.timeout).toBeGreaterThan(entry.failClosedBudget ?? 0);
    }
  });

  test('every wired unit exists as a hook in the tree', () => {
    const units = new Set(
      collectFacts().units.filter((unit) => unit.mechanisms.includes('hook')).map((u) => u.name),
    );

    for (const entry of collectWiring()) {
      expect(units).toContain(entry.unit);
    }
  });

  test('event, matcher, timeout and budget are read from the settings', () => {
    write(
      'hooks/claude/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: '$HOME/.claude/hooks/alpha-police.sh', timeout: 10 },
                {
                  type: 'command',
                  command: '$HOME/.claude/hooks/fail-closed-hook.sh 45 $HOME/.claude/hooks/beta-police.sh',
                  timeout: 60,
                },
                { type: 'command', command: '$HOME/.claude/hooks/chime.sh', timeout: 5 },
              ],
            },
          ],
        },
      }),
    );

    expect(collectWiring(root)).toEqual([
      { unit: 'alpha', event: 'PreToolUse', matcher: 'Bash', timeout: 10, failClosedBudget: null },
      { unit: 'beta', event: 'PreToolUse', matcher: 'Bash', timeout: 60, failClosedBudget: 45 },
    ]);
  });

  test('a wrapped hook is attributed to the guard, not to the wrapper', () => {
    write(
      'hooks/claude/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: '$HOME/.claude/hooks/fail-closed-hook.sh 30 $HOME/.claude/hooks/gamma-police.sh',
                  timeout: 40,
                },
              ],
            },
          ],
        },
      }),
    );

    expect(collectWiring(root)[0]?.unit).toBe('gamma');
  });

  test('unreadable settings yield no wiring rather than a partial table', () => {
    write('hooks/claude/settings.json', 'not json');

    expect(collectWiring(root)).toEqual([]);
  });
});

describe('the README skills table comes from the tree', () => {
  test('a block-scalar description folds to its prose, not the indicator', () => {
    write('skills/KITS', 'kit core Everyday skills\n');
    write(
      'skills/folded/SKILL.md',
      '---\nname: folded\ndescription: >-\n  First half of the\n  folded prose.\n---\n',
    );

    const facts = collectFacts(root);
    expect(facts.skills[0]?.description).toBe('First half of the folded prose.');
  });

  test('the committed README matches a regeneration, and an edited row is caught', () => {
    const repo = join(import.meta.dir, '..', '..');
    const readme = readFileSync(join(repo, 'README.md'), 'utf-8');
    const facts = collectFacts(repo);

    expect(spliceReadme(readme, facts)).toBe(readme);

    const tampered = readme.replace('**gitops-master**', '**gitops-master-renamed**');
    expect(spliceReadme(tampered, facts)).not.toBe(tampered);
  });

  test('a README without the marker pair fails loudly instead of silently skipping', () => {
    write('skills/KITS', 'kit core Everyday skills\n');
    skill('ordinary', 'Always installed.');

    expect(() => spliceReadme('# no markers here\n', collectFacts(root)))
      .toThrow('marker pair');
  });
});

describe('generated data reaches a page only through a component', () => {
  // Pages render generated data through components, never by importing the JSON
  // directly — the components are the one place table markup and any future
  // data resolution live, and a page that bypasses them forks that in silence.
  test('no content page imports the generated tables directly', () => {
    const root = join(import.meta.dir, '..', '..', 'docs', 'hextra', 'content');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.mdx?$/.test(entry.name)) continue;
        const body = readFileSync(path, 'utf-8');
        // No `^` anchor and no line discipline: an indented import, or one split
        // across lines, bypassed the anchored version and still rendered.
        for (const match of body.matchAll(/import[\s\S]{0,200}?from\s*["'][^"']*generated\//g)) {
          offenders.push(`${relative(root, path)}: ${match[0]}`);
        }
      }
    };

    walk(root);

    expect(offenders).toEqual([]);
  });
});

describe('the content tree holds only content', () => {
  // Content-collection tooling walks this directory without consulting git, so
  // a stray non-markdown file breaks builds with errors that name no file — and
  // a gitignored one is invisible to `git status` while doing it. That cost
  // hours once: OMC had written its session state to
  // `src/content/docs/.omc/state/*.jsonl` because an agent ran with that
  // directory as its cwd.
  test('no file under the content tree is anything but markdown', () => {
    const root = join(import.meta.dir, '..', '..', 'docs', 'hextra', 'content');
    const strays: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.mdx?$/.test(entry.name)) strays.push(relative(root, path));
      }
    };

    walk(root);

    expect(strays).toEqual([]);
  });
});
