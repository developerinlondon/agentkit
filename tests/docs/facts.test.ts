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
} from '../../scripts/sync-docs-facts.ts';
import {
  factsFor,
  frozenByVersion,
  versionFromPathname,
} from '../../docs/site/src/lib/version-facts.ts';

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
      {
        name: 'alpha',
        mechanisms: ['hook', 'plugin', 'codexPolicy'],
        claudePlugins: ['agentkit'],
      },
      { name: 'beta', mechanisms: ['hook'], claudePlugins: [] },
      { name: 'gamma', mechanisms: ['plugin'], claudePlugins: [] },
    ]);
  });

  // Packaging a hook is not a fourth mechanism: the plugin copy is generated
  // from hooks/claude. A page that counted it as one would overstate coverage.
  test('a plugin copy is packaging, not an extra mechanism', () => {
    write('skills/GROUPS', 'group core Everyday\n');
    write('hooks/claude/solo-police.sh', '#!/usr/bin/env bash\n');
    write('plugins-cc/agentkit/hooks/solo-police.sh', '#!/usr/bin/env bash\n');
    write('plugins-cc/agentkit-strict-review/hooks/solo-police.sh', '#!/usr/bin/env bash\n');
    mkdirSync(join(root, 'skills'), { recursive: true });

    const unit = collectFacts(root).units[0];

    expect(unit?.mechanisms).toEqual(['hook']);
    expect(unit?.claudePlugins).toEqual(['agentkit', 'agentkit-strict-review']);
  });

  test('a unit that exists only as a packaged hook is still reported', () => {
    write('skills/GROUPS', 'group core Everyday\n');
    write('plugins-cc/agentkit/hooks/orphan-police.sh', '#!/usr/bin/env bash\n');
    mkdirSync(join(root, 'skills'), { recursive: true });

    expect(collectFacts(root).units).toEqual([
      { name: 'orphan', mechanisms: [], claudePlugins: ['agentkit'] },
    ]);
  });
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

describe('the skill and group tables come from skills/GROUPS', () => {
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

  // Pins the contract rather than the current guard: today the tokenizer keeps
  // `#` as the first field, so a comment cannot become a record even without the
  // skip. A reader rewritten to strip comment markers instead would assign from
  // the prose that documents the format, and this is what would catch it.
  test('a commented-out membership never assigns a skill', () => {
    write(
      'skills/GROUPS',
      [
        '# <skill> <group> puts a skill in a declared group',
        '# guarded locked',
        'group core Everyday skills',
        'group locked Consent-gated lane',
        'explicit locked',
      ].join('\n'),
    );
    skill('guarded', 'Should not be in the locked group.');

    const guarded = collectFacts(root).skills.find((entry) => entry.name === 'guarded');

    expect(guarded?.group).toBe('core');
    expect(guarded?.explicit).toBe(false);
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

describe('the prose that enumerates units stays complete', () => {
  // The "what each unit refuses" column cannot be generated — the wording lives
  // nowhere machine-readable. Its completeness can be, so adding or removing a
  // unit fails here instead of leaving the page quietly short of one.
  test('the hooks reference documents exactly the units in the tree', () => {
    const page = readFileSync(
      join(import.meta.dir, '..', '..', 'docs', 'site', 'src', 'content', 'docs', 'reference', 'hooks.mdx'),
      'utf-8',
    );
    const documented = [...page.matchAll(/^\| `([a-z-]+)-police` \|/gm)].map((match) => match[1]);
    const inTree = collectFacts().units.map((unit) => unit.name);

    expect(documented.slice().sort()).toEqual(inTree.slice().sort());
  });
});

describe('content stays parseable by the version archiver', () => {
  // starlight-versions applies remark-mdx to every page regardless of extension,
  // so a CommonMark autolink — legal markdown, and accepted by the normal build —
  // reads as a JSX tag and aborts archiving. That failure would otherwise surface
  // only at the next release, long after the page was written.
  test('no page uses a CommonMark autolink', () => {
    const root = join(import.meta.dir, '..', '..', 'docs', 'site', 'src', 'content', 'docs');
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
        for (const match of body.matchAll(/<(https?|mailto):[^>\s]*>/g)) {
          offenders.push(`${relative(root, path)}: ${match[0]}`);
        }
      }
    };

    walk(root);

    expect(offenders).toEqual([]);
  });
});

describe('a frozen version renders its own tables', () => {
  test('a versioned path resolves to its frozen snapshot', () => {
    const current = { units: ['now'], wiring: [], groups: [], skills: [], tools: [] };
    const frozen = {
      '0.4': { units: ['then'], wiring: [], groups: [], skills: [], tools: [] },
    };

    const resolved = factsFor('/docs/0.4/reference/hooks/', current, frozen);

    expect(resolved.version).toBe('0.4');
    expect(resolved.frozen).toBe(true);
    expect(resolved.facts.units).toEqual(['then']);
  });

  test('the unversioned root resolves to the current tree', () => {
    const current = { units: ['now'], wiring: [], groups: [], skills: [], tools: [] };
    const frozen = {
      '0.4': { units: ['then'], wiring: [], groups: [], skills: [], tools: [] },
    };

    const resolved = factsFor('/docs/reference/hooks/', current, frozen);

    expect(resolved.version).toBeNull();
    expect(resolved.frozen).toBe(false);
    expect(resolved.facts.units).toEqual(['now']);
  });

  // Falling back to the current tree is the lesser wrong: an empty table would
  // read as "this release had no units", which is a stronger and falser claim
  // than "these are the current ones".
  test('a declared version with no snapshot falls back and says so', () => {
    const current = { units: ['now'], wiring: [], groups: [], skills: [], tools: [] };

    const resolved = factsFor('/docs/9.9/reference/hooks/', current, {});

    expect(resolved.version).toBe('9.9');
    expect(resolved.frozen).toBe(false);
    expect(resolved.facts.units).toEqual(['now']);
  });

  test.each([
    ['/docs/', null],
    ['/docs/concepts/pages/', null],
    ['/docs/0.4/', '0.4'],
    ['/docs/1/', '1'],
    ['/docs/10.2.3/', '10.2.3'],
    ['/docs/0.4rc/', null],
    ['/docs/v0.4/', null],
  ])('%s yields version %s', (pathname, expected) => {
    expect(versionFromPathname(pathname)).toBe(expected);
  });

  test('a glob of snapshot modules is keyed by version', () => {
    const modules = {
      '../generated/frozen-facts/0.4.json': { default: { units: ['a'], wiring: [], groups: [], skills: [], tools: [] } },
      '../generated/frozen-facts/0.5.json': { default: { units: ['b'], wiring: [], groups: [], skills: [], tools: [] } },
    };

    expect(Object.keys(frozenByVersion(modules)).sort()).toEqual(['0.4', '0.5']);
  });
});

describe('generated data reaches a page only through a component', () => {
  // Only components call factsFor, so a page importing the generated JSON directly
  // renders the current tree even when it is an archived version. Fixing the one
  // page that did this was not enough — the archived copy is the page where it
  // actually matters, and it was missed. This makes the whole class unrepeatable.
  test('no content page imports the generated tables directly', () => {
    const root = join(import.meta.dir, '..', '..', 'docs', 'site', 'src', 'content', 'docs');
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
