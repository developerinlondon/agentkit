import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  evaluateCommand,
  MATCH_DEADLINE_MS,
  MAX_SUBJECT_LENGTH,
} from '../../skills/taste/scripts/police.ts';
import { resolveTastes } from '../../skills/taste/scripts/resolve.ts';
import { RULE_KINDS } from '../../skills/taste/scripts/rules/kinds.ts';

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
  policy?: string;
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

    // Where the version-skew guarantee is actually delivered: the lint runs
    // again as the hook loads the folder, so the taste is dropped there. The
    // notice has to carry enough to act on — which file, and which kinds this
    // agentkit does implement.
    const verdict = await judge(TAG_MINOR, where);
    const notices = verdict.notices.join('\n');

    expect(verdict.decision).toBe('allow');
    expect(notices).toContain('release-tier.md');
    expect(notices).toContain('rule.kind');
    for (const kind of RULE_KINDS) expect(notices).toContain(kind);
  });

  // And the taste beside it keeps enforcing: one file from a newer agentkit
  // must cost its own enforcement and nobody else's.
  test('a taste of an unknown kind does not disarm the tastes around it', async () => {
    const where = project({
      '.agentkit/tastes/from-the-future.md': taste({
        name: 'from-the-future',
        scope: 'project',
        strength: 'require',
        enforce: 'block',
        provenance: '2026-08-06 · a newer agentkit',
      }, { kind: 'git-worktree-shape', policy: 'whatever', remedy: 'Do it another way.' }),
      '.agentkit/tastes/release-tier.md': releaseTier(),
    });

    const verdict = await judge(TAG_MINOR, where);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('release-tier');
    expect(verdict.reason).toContain('from-the-future');
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
    const where = project({
      '.agentkit/config.yaml': 'taste:\n  sources:\n    - repo: https://example.invalid/org.git\n'
        + '      ref: v1\n      name: org\n',
      '.agentkit/tastes/external/org/release-tier.md': external,
    }, userBlocks);

    expect((await judge(TAG_MINOR, where)).decision).toBe('allow');
    const resolved = resolveTastes(where.cwd, where.home, {}).tastes[0];
    expect(resolved?.layer).toBe('project-external');
  });

  test('an absent external directory costs nothing', async () => {
    const where = project({}, userBlocks);
    expect(resolveTastes(where.cwd, where.home, {}).warnings).toEqual([]);
  });
});

describe('a second blocking taste needs no new code', () => {
  const guardSources = [
    join(repoRoot, 'hooks', 'claude', 'taste-police.sh'),
    join(repoRoot, 'plugins', 'taste-police.ts'),
    join(repoRoot, 'skills', 'taste', 'scripts', 'police.ts'),
    join(repoRoot, 'skills', 'taste', 'scripts', 'resolve.ts'),
    join(repoRoot, 'skills', 'taste', 'scripts', 'layout.ts'),
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
      // This bound proves only that the session came back rather than hanging —
      // a three-second deadline would satisfy it too. What pins the deadline is
      // the assertion on MATCH_DEADLINE_MS above, and what proves the evaluator
      // reached its own abandon path is the skip notice below. The literal is
      // deliberate: a bound derived from the constant would move with it and
      // pass at any deadline at all.
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
      // Everything the evaluator imports, copied whole except the one thread it
      // matches on. Enumerating the modules instead would make this test fail
      // the day another one is added, rather than the day the skip breaks.
      cpSync(join(repoRoot, 'skills', 'taste', 'scripts'), scriptDir, { recursive: true });
      rmSync(join(scriptDir, 'match.ts'), { force: true });
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

// The second kind, through the whole hook: a taste file on disk, a real
// repository with real tags, and the same refusal machinery the first kind
// uses. What differs is only that the finding comes from git state rather than
// from the command string.
describe('a git-tag-sequence taste refuses out of the repository\'s own tags', () => {
  function tagSequence(policy: string, override = 'AGENTKIT_TAG_SEQUENCE'): string {
    return taste({
      name: 'tag-sequence',
      scope: 'project',
      strength: 'require',
      enforce: 'block',
      provenance: '2026-08-06 · session correction',
    }, {
      kind: 'git-tag-sequence',
      policy,
      remedy: 'Read the existing tags and cut the next patch on that line.',
      override,
    });
  }

  function git(dir: string, ...args: string[]): void {
    Bun.spawnSync({
      cmd: ['git', ...args],
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
  }

  function tagged(tags: string[], policy = 'no-backwards-in-line') {
    const where = project({ '.agentkit/tastes/tag-sequence.md': tagSequence(policy) });
    writeFileSync(join(where.cwd, 'file.txt'), 'contents');
    git(where.cwd, 'init', '-q', '-b', 'main');
    git(where.cwd, 'add', '-A');
    git(where.cwd, 'commit', '-q', '-m', 'one');
    for (const tag of tags) git(where.cwd, 'tag', tag);
    return where;
  }

  test('a backwards tag is refused with this taste\'s own remedy and override', async () => {
    const where = tagged(['v0.6.2', 'v0.6.5', 'v0.7.11']);
    const verdict = await judge('git tag v0.6.3', where);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('BLOCKED by taste tag-sequence');
    expect(verdict.reason).toContain('v0.6.5');
    expect(verdict.reason).toContain('Read the existing tags');
    expect(verdict.reason).toContain('AGENTKIT_TAG_SEQUENCE');
  });

  test('a maintenance tag on a lower line passes', async () => {
    const where = tagged(['v0.6.5', 'v0.7.11']);

    expect((await judge('git tag v0.6.6', where)).decision).toBe('allow');
  });

  // Mutating the guard's INPUT rather than the guard: same command, same hook,
  // different tags in the repository. If this still denied, the refusal above
  // came from something other than the tags.
  test('removing the tag it was behind removes the refusal', async () => {
    const where = tagged(['v0.7.11']);

    expect((await judge('git tag v0.6.3', where)).decision).toBe('allow');
  });

  test('the policy is the taste\'s, not the tool\'s', async () => {
    const strict = tagged(['v0.6.5', 'v0.7.11'], 'strict-successor');

    expect((await judge('git tag v0.6.6', strict)).decision).toBe('deny');
  });

  test('the override lets one tag through, deliberately', async () => {
    const where = tagged(['v0.6.5']);
    const verdict = await judge('AGENTKIT_TAG_SEQUENCE=1 git tag v0.6.3', where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join('\n')).toContain('AGENTKIT_TAG_SEQUENCE');
  });

  test('a repository whose tags cannot be read allows, and says UNCHECKED', async () => {
    const where = tagged(['v0.7.11']);
    writeFileSync(join(where.cwd, '.git', 'packed-refs'), 'this file is not a ref database\n');
    const verdict = await judge('git tag v0.1.1', where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join('\n')).toContain('UNCHECKED');
    expect(verdict.notices.join('\n')).toContain('tag-sequence');
  });

  test('a directory that is not a repository allows silently', async () => {
    const where = project({ '.agentkit/tastes/tag-sequence.md': tagSequence('strict-successor') });
    const verdict = await judge('git tag v0.1.1', where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
  });

  test('a command that proposes no tag is untouched', async () => {
    const where = tagged(['v0.7.11']);
    const verdict = await judge('git push origin main', where);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
  });
});
