import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  evaluateCommand,
  MATCH_DEADLINE_MS,
  MAX_SUBJECT_LENGTH,
} from '../../skills/taste/scripts/police.ts';
import { resolveTastes } from '../../skills/taste/scripts/resolve.ts';

const repoRoot = join(import.meta.dir, '..', '..');
const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    rmSync(sandboxes.pop() as string, { recursive: true, force: true });
  }
});

function sandbox(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-taste-police-'));
  sandboxes.push(root);
  write(root, files);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

const BODY = [
  'Cut patch releases by default.',
  '',
  'Why: "publish this" authorizes a release, never the tier.',
  '',
  'How to apply: propose the patch version in the release PR.',
  '',
].join('\n');

interface Rule {
  kind?: string;
  match?: string;
  remedy?: string;
  override?: string;
}

function taste(fields: Record<string, string>, rule?: Rule, body = BODY): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  if (rule) {
    lines.push('rule:');
    for (const [key, value] of Object.entries(rule)) lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

const RELEASE_RULE: Rule = {
  kind: 'command',
  match: 'git tag .*\\bv[0-9]+\\.[0-9]+\\.0\\b',
  remedy: "Cut a patch tag, or record the owner's agreement in the release PR first.",
  override: 'AGENTKIT_RELEASE_TIER',
};

function releaseTier(scope = 'project', rule: Rule | undefined = RELEASE_RULE): string {
  return taste({
    name: 'release-tier',
    scope,
    strength: 'require',
    enforce: rule === undefined ? 'advise' : 'block',
    provenance: '2026-08-05 · session correction',
  }, rule);
}

// project = the repository the command runs in, home = the user layer. Every
// case builds both, because the resolution the hook performs is the thing
// under test as much as the matching is.
function project(files: Record<string, string> = {}, homeFiles: Record<string, string> = {}) {
  const cwd = sandbox(files);
  const home = sandbox(homeFiles);
  return { cwd, home };
}

function judge(
  command: string,
  where: { cwd: string; home: string },
  env: Record<string, string | undefined> = {},
) {
  return evaluateCommand({ command, cwd: where.cwd, home: where.home, env });
}

const TAG_MINOR = 'git tag v0.8.0';
const TAG_PATCH = 'git tag v0.7.5';

describe('taste-police refuses what a block rule matches', () => {
  test('a matching command is refused with the taste\'s own words', async () => {
    const where = project({ '.agentkit/tastes/release-tier.md': releaseTier() });
    const verdict = await judge(TAG_MINOR, where);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('BLOCKED');
    expect(verdict.reason).toContain('release-tier');
    expect(verdict.reason).toContain('.agentkit/tastes/release-tier.md');
    expect(verdict.reason).toContain('Cut a patch tag');
    expect(verdict.reason).toContain('AGENTKIT_RELEASE_TIER');
  });

  test('a command the rule does not match passes untouched', async () => {
    const where = project({ '.agentkit/tastes/release-tier.md': releaseTier() });
    const verdict = await judge(TAG_PATCH, where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
  });

  // Mutating the guard's INPUT: the rule is data, so the counterfactual that
  // proves the refusal came from THIS file is the same command against the same
  // hook with the pattern changed. If this still denied, the test above would be
  // passing on something other than the taste.
  test('mutating the fixture\'s match stops the refusal', async () => {
    const mutated = { ...RELEASE_RULE, match: 'git tag .*\\bnever-matches-this\\b' };
    const where = project({ '.agentkit/tastes/release-tier.md': releaseTier('project', mutated) });

    expect((await judge(TAG_MINOR, where)).decision).toBe('allow');
  });

  test('enforce: advise carries no refusal even with a rule present', async () => {
    const advise = taste({
      name: 'release-tier',
      scope: 'project',
      strength: 'require',
      enforce: 'check',
      provenance: '2026-08-05 · session correction',
    }, RELEASE_RULE);
    const where = project({ '.agentkit/tastes/release-tier.md': advise });

    expect((await judge(TAG_MINOR, where)).decision).toBe('allow');
  });

  test('a rule of an unknown kind enforces nothing', async () => {
    const where = project({
      '.agentkit/tastes/release-tier.md': releaseTier('project', {
        ...RELEASE_RULE,
        kind: 'edit',
      }),
    });

    // The lint refuses the kind, so the file is malformed rather than silently
    // inert — and either way nothing is refused on its behalf.
    const verdict = await judge(TAG_MINOR, where);
    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join('\n')).toContain('release-tier.md');
  });
});

describe('the override is deliberate, and fails closed', () => {
  const files = { '.agentkit/tastes/release-tier.md': releaseTier() };

  test('set inline in the command, it lets that command through with a notice', async () => {
    const where = project(files);
    const verdict = await judge(`AGENTKIT_RELEASE_TIER=minor ${TAG_MINOR}`, where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join('\n')).toContain('AGENTKIT_RELEASE_TIER');
    expect(verdict.notices.join('\n')).toContain('release-tier');
  });

  test('set in the environment, it lets the command through too', async () => {
    const where = project(files);
    const verdict = await judge(TAG_MINOR, where, { AGENTKIT_RELEASE_TIER: 'minor' });

    expect(verdict.decision).toBe('allow');
  });

  test.each([['0'], ['false'], ['off'], ['no'], ['']])(
    'a value of %p reads as off, so it warns and still refuses',
    async (value) => {
      const where = project(files);
      const verdict = await judge(`AGENTKIT_RELEASE_TIER=${value} ${TAG_MINOR}`, where);

      expect(verdict.decision).toBe('deny');
      expect(verdict.reason).toContain('does not read as a deliberate override');
      expect(verdict.reason).toContain('Cut a patch tag');
    },
  );

  test('a misspelled variable name is simply not the override', async () => {
    const where = project(files);
    const verdict = await judge(`AGENTKIT_RELEASE_TEIR=minor ${TAG_MINOR}`, where);

    expect(verdict.decision).toBe('deny');
  });

  test('a taste with no override says so instead of naming one', async () => {
    const noOverride = { ...RELEASE_RULE };
    delete noOverride.override;
    const where = project({
      '.agentkit/tastes/release-tier.md': releaseTier('project', noOverride),
    });
    const verdict = await judge(TAG_MINOR, where);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('declares no override');
  });
});

describe('scope resolution decides which file enforces', () => {
  const userBlocks = { '.agentkit/tastes/release-tier.md': releaseTier('user') };

  test('a user taste enforces when the project has nothing to say', async () => {
    const where = project({}, userBlocks);
    expect((await judge(TAG_MINOR, where)).decision).toBe('deny');
  });

  test('a project taste of the same name replaces the user one outright', async () => {
    const projectAdvises = taste({
      name: 'release-tier',
      scope: 'project',
      strength: 'prefer',
      enforce: 'advise',
      provenance: '2026-08-05 · this repository differs',
    });
    const where = project({ '.agentkit/tastes/release-tier.md': projectAdvises }, userBlocks);

    expect((await judge(TAG_MINOR, where)).decision).toBe('allow');
    const resolution = resolveTastes(where.cwd, where.home);
    const resolved = resolution.tastes.find((entry) => entry.name === 'release-tier');
    expect(resolved?.layer).toBe('project');
    expect(resolved?.shadows).toEqual(['user']);
  });

  test('the external layer sits between project and user', async () => {
    const external = taste({
      name: 'release-tier',
      scope: 'external',
      strength: 'require',
      enforce: 'advise',
      provenance: '2026-08-05 · vendored policy',
    });
    const where = project({ '.agentkit/tastes-vendor/org/release-tier.md': external }, userBlocks);

    expect((await judge(TAG_MINOR, where)).decision).toBe('allow');
    const resolved = resolveTastes(where.cwd, where.home).tastes[0];
    expect(resolved?.layer).toBe('external');
  });

  test('an absent tastes-vendor directory costs nothing', async () => {
    const where = project({}, userBlocks);
    expect(resolveTastes(where.cwd, where.home).warnings).toEqual([]);
  });
});

describe('a second blocking taste needs no new code', () => {
  const guardSources = [
    join(repoRoot, 'hooks', 'claude', 'taste-police.sh'),
    join(repoRoot, 'plugins', 'taste-police.ts'),
    join(repoRoot, 'skills', 'taste', 'scripts', 'police.ts'),
    join(repoRoot, 'skills', 'taste', 'scripts', 'resolve.ts'),
  ];


  test('adding one to the folder enforces it, with no code touched', async () => {
    const where = project({ '.agentkit/tastes/release-tier.md': releaseTier() });

    expect((await judge('rm -rf /', where)).decision).toBe('allow');

    write(where.cwd, {
      '.agentkit/tastes/no-recursive-force.md': taste({
        name: 'no-recursive-force',
        scope: 'project',
        strength: 'require',
        enforce: 'block',
        provenance: '2026-08-05 · owner',
      }, {
        kind: 'command',
        match: '\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*f\\b',
        remedy: 'Delete the specific paths by name.',
        override: 'AGENTKIT_ALLOW_RECURSIVE_FORCE',
      }),
    });

    const verdict = await judge('rm -rf /', where);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('no-recursive-force');
    expect(verdict.reason).toContain('Delete the specific paths by name.');
    // The original taste still enforces: adding one did not replace the folder.
    expect((await judge(TAG_MINOR, where)).decision).toBe('deny');
  });

  // The other half of "generic": the guard must not know the name of anything it
  // refuses. A file that mentions a taste is a rule that stopped being data.
  test('no guard source mentions a taste it enforces', () => {
    for (const path of guardSources) {
      const source = readFileSync(path, 'utf-8');
      for (const name of ['release-tier', 'no-recursive-force', 'AGENTKIT_RELEASE_TIER']) {
        expect(source.includes(name), `${path} must not name ${name}`).toBe(false);
      }
    }
  });
});

describe('a malformed taste is loud, and never contagious', () => {
  test('it is skipped with a warning while its neighbours keep enforcing', async () => {
    const where = project({
      '.agentkit/tastes/release-tier.md': releaseTier(),
      '.agentkit/tastes/broken.md': '---\nname: broken\nscope: [not, a, scalar\n---\n\nbody\n',
    });
    const verdict = await judge(TAG_MINOR, where);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('broken.md');
    expect(verdict.reason).toContain('release-tier');
  });

  test('a folder of nothing but broken files warns rather than reading as empty', async () => {
    const where = project({
      '.agentkit/tastes/broken.md': '---\nname: mismatched\nscope: project\n---\n\nbody\n',
    });
    const verdict = await judge(TAG_MINOR, where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join('\n')).toContain('broken.md');
  });

  test('a pattern longer than the cap is refused at load, not run', async () => {
    const long = `git tag ${'a|'.repeat(200)}z`;
    const where = project({
      '.agentkit/tastes/release-tier.md': releaseTier('project', { ...RELEASE_RULE, match: long }),
    });
    const verdict = await judge(TAG_MINOR, where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join('\n')).toContain('characters');
  });

  // The number, not just the mechanism. Deriving the padding from the constant
  // alone would let 4000 become 4_000_000 — the cap still "works", against a
  // subject nothing bounds.
  test('the subject cap is 4000 characters', () => {
    expect(MAX_SUBJECT_LENGTH).toBe(4000);
  });

  // Both length caps can be satisfied by a pattern that still runs for longer
  // than anyone will wait: this one doubles its work every two characters, and
  // is 8 characters long.
  describe('a pattern that backtracks catastrophically', () => {
    const EVIL = '(a+)+$';
    const evilTaste = taste({
      name: 'evil',
      scope: 'project',
      strength: 'require',
      enforce: 'block',
      provenance: '2026-08-05 · owner',
    }, { kind: 'command', match: EVIL, remedy: 'Never fires.', override: 'AGENTKIT_EVIL' });
    const feed = `${'a'.repeat(46)}!`;

    test('the deadline is a quarter second', () => {
      expect(MATCH_DEADLINE_MS).toBe(250);
    });

    test('is abandoned at the deadline instead of hanging the session', async () => {
      const where = project({ '.agentkit/tastes/evil.md': evilTaste });

      const started = performance.now();
      const verdict = await judge(feed, where);
      const elapsed = performance.now() - started;

      expect(verdict.decision).toBe('allow');
      // A literal, not a multiple of the constant under test: a bound derived
      // from the deadline moves with it, and would pass at any deadline at all.
      // Generous against a slow CI box, and still nothing next to the wall-clock
      // cost of letting that pattern finish.
      expect(elapsed).toBeLessThan(2000);
    });

    test('names the taste it skipped, rather than failing anonymously', async () => {
      const where = project({ '.agentkit/tastes/evil.md': evilTaste });
      const notices = (await judge(feed, where)).notices.join('\n');

      expect(notices).toContain('evil');
      expect(notices).toContain(String(MATCH_DEADLINE_MS));
      expect(notices).toContain('evil.md');
    });

    // A half-installed evaluator — police.ts present, the thread it matches on
    // missing — must skip the taste like any other unusable rule. Loaded from a
    // copy so the failure is real rather than mocked.
    test('a matcher that cannot start skips the taste instead of crashing', async () => {
      const scriptDir = sandbox({});
      for (const name of ['police.ts', 'resolve.ts', 'lint.ts']) {
        writeFileSync(
          join(scriptDir, name),
          readFileSync(join(repoRoot, 'skills', 'taste', 'scripts', name), 'utf-8'),
        );
      }
      const where = project({ '.agentkit/tastes/release-tier.md': releaseTier() });

      const broken = await import(join(scriptDir, 'police.ts')) as {
        evaluateCommand: typeof evaluateCommand;
      };
      const verdict = await broken.evaluateCommand({
        command: TAG_MINOR,
        cwd: where.cwd,
        home: where.home,
        env: {},
      });

      expect(verdict.decision).toBe('allow');
      expect(verdict.notices.join('\n')).toContain('release-tier');
      expect(verdict.notices.join('\n')).toContain('could not be run');
    });

    // The failure this closes is not the hang alone: one bad pattern must not
    // become a way to switch every other blocking taste off.
    test('the tastes around it keep enforcing', async () => {
      const where = project({
        '.agentkit/tastes/evil.md': evilTaste,
        '.agentkit/tastes/release-tier.md': releaseTier(),
      });
      const verdict = await judge(`${feed} && ${TAG_MINOR}`, where);

      expect(verdict.decision).toBe('deny');
      expect(verdict.reason).toContain('release-tier');
      // The refusal an agent reads carries the skip too, or enforcement looks
      // complete when part of it silently did not run.
      expect(verdict.reason).toContain('evil');
    });
  });

  test('only the first slice of a command is matched', async () => {
    const where = project({ '.agentkit/tastes/release-tier.md': releaseTier() });
    const padded = `${'x'.repeat(4000)} && ${TAG_MINOR}`;

    expect((await judge(padded, where)).decision).toBe('allow');
    expect((await judge(`${TAG_MINOR} && ${'x'.repeat(MAX_SUBJECT_LENGTH)}`, where)).decision).toBe('deny');
  });
});

describe('taste.enabled switches the whole hook off', () => {
  const files = { '.agentkit/tastes/release-tier.md': releaseTier() };

  test('absent config enforces', async () => {
    expect((await judge(TAG_MINOR, project(files))).decision).toBe('deny');
  });

  test('taste.enabled: true enforces', async () => {
    const where = project({ ...files, '.agentkit/config.yaml': 'taste:\n  enabled: true\n' });
    expect((await judge(TAG_MINOR, where)).decision).toBe('deny');
  });

  test('taste.enabled: false makes it inert', async () => {
    const where = project({ ...files, '.agentkit/config.yaml': 'taste:\n  enabled: false\n' });
    const verdict = await judge(TAG_MINOR, where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
  });

  test('the repository config overrides the user one', async () => {
    const where = project(
      { ...files, '.agentkit/config.yaml': 'taste:\n  enabled: true\n' },
      { '.config/agentkit/config.yaml': 'taste:\n  enabled: false\n' },
    );
    expect((await judge(TAG_MINOR, where)).decision).toBe('deny');
  });

  test('the user config applies when the repository says nothing', async () => {
    const where = project(files, { '.config/agentkit/config.yaml': 'taste:\n  enabled: false\n' });
    expect((await judge(TAG_MINOR, where)).decision).toBe('allow');
  });
});
