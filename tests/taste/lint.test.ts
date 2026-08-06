import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  lintTasteDirectory,
  lintTastePath,
  MAX_MATCH_LENGTH,
} from '../../skills/taste/scripts/lint.ts';

const repoRoot = join(import.meta.dir, '..', '..');
const linter = join(repoRoot, 'skills', 'taste', 'scripts', 'lint.ts');
const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    rmSync(sandboxes.pop() as string, { recursive: true, force: true });
  }
});

function sandbox(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-tastes-'));
  sandboxes.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function lint(files: Record<string, string>): string[] {
  return lintTasteDirectory(sandbox(files));
}

const BODY = [
  'Cut patch releases by default.',
  '',
  'Why: "publish this" authorizes a release, never the tier.',
  '',
  'How to apply: propose the patch version in the release PR.',
  '',
].join('\n');

function taste(fields: Record<string, string>, body = BODY): string {
  const front = Object.entries(fields)
    .map(([key, value]) => (value.includes('\n') ? `${key}:\n${value}` : `${key}: ${value}`))
    .join('\n');
  return `---\n${front}\n---\n\n${body}`;
}

const MINIMAL = {
  name: 'branch-naming',
  scope: 'project',
  strength: 'require',
  provenance: '2026-08-05 · session correction',
};

function withFields(overrides: Record<string, string>): Record<string, string> {
  return { ...MINIMAL, ...overrides };
}

// The example the format reference documents is the fixture the lint is run
// against, so a doc that drifts from the contract fails here rather than in a
// future session that copied it.
function documentedTastes(): Record<string, string> {
  const reference = readFileSync(
    join(repoRoot, 'skills', 'taste', 'references', 'format.md'),
    'utf-8',
  );
  const blocks = [...reference.matchAll(/```markdown\n([\s\S]*?)```/g)].map((match) => match[1]);
  const files: Record<string, string> = {};
  for (const block of blocks) {
    const name = /^name:\s*(\S+)$/m.exec(block)?.[1];
    expect(name, 'a documented taste example carries a name').toBeDefined();
    files[`${name}.md`] = block;
  }
  return files;
}

describe('a taste folder the contract accepts', () => {
  test('every taste example in references/format.md lints clean', () => {
    const documented = documentedTastes();
    expect(Object.keys(documented)).toContain('release-tier.md');
    expect(lint(documented)).toEqual([]);
  });

  test('a folder mixing enforce levels, categories, and subdirectories passes', () => {
    expect(lint({
      ...documentedTastes(),
      'mr-style.md': taste(withFields({ name: 'mr-style', strength: 'prefer', category: 'git' })),
      'writing/tone.md': taste(withFields({ name: 'tone', scope: 'user' })),
      'commit-identity.md': taste(withFields({
        name: 'commit-identity',
        enforce: 'check',
        rule: "  kind: command\n  match: 'git commit'\n  remedy: Use the configured identity.",
      })),
    })).toEqual([]);
  });

  test('a non-markdown file in the folder is not a taste and is ignored', () => {
    expect(lint({ ...documentedTastes(), 'README.txt': 'not a taste' })).toEqual([]);
  });
});

describe('the name is the key', () => {
  test('a name that is not kebab-case is rejected', () => {
    const errors = lint({ 'release_tier.md': taste(withFields({ name: 'release_tier' })) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('release_tier.md');
    expect(errors[0]).toContain('kebab-case');
  });

  test('a numbered filename is rejected — a taste folder is not a record', () => {
    const errors = lint({ '003-release-tier.md': taste(withFields({ name: '003-release-tier' })) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('kebab-case');
  });

  test('a name that disagrees with its filename is rejected', () => {
    const errors = lint({ 'release-tier.md': taste(withFields({ name: 'release-tiers' })) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('release-tier.md');
    expect(errors[0]).toContain('release-tiers');
    expect(errors[0]).toContain('filename');
  });

  test('the same name in two subdirectories collides — the resolver keys on the name', () => {
    const errors = lint({
      'release/tier.md': taste(withFields({ name: 'tier' })),
      'git/tier.md': taste(withFields({ name: 'tier' })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate');
    expect(errors[0]).toContain('git/tier.md');
    expect(errors[0]).toContain('release/tier.md');
  });

  // Both of these are the same collision written two ways YAML considers equal.
  // Keying dedupe on the raw line rather than the parsed value lets either one
  // through, and two tastes with one name is the state the folder must not reach.
  test('a quoted name still collides — dedupe keys on the parsed value', () => {
    const errors = lint({
      'release/tier.md': taste(withFields({ name: '"tier"' })),
      'git/tier.md': taste(withFields({ name: 'tier' })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate');
  });

  test('a trailing comment on the name line does not hide a collision', () => {
    const errors = lint({
      'release/tier.md': taste(withFields({ name: 'tier # the 2026-08-05 correction' })),
      'git/tier.md': taste(withFields({ name: 'tier' })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate');
  });
});

// One directory per source, and a name two sources both define is the stacking
// the sources list exists for — the later one is subscribed to precisely to win
// it. Dedupe therefore stops at the source boundary, as it already does when
// each source is linted on its own.
describe('the external tree is a stack of sources, not one folder', () => {
  function externalRoot(files: Record<string, string>, root = 'external'): string {
    const nested: Record<string, string> = {};
    for (const [path, contents] of Object.entries(files)) nested[`${root}/${path}`] = contents;
    return join(sandbox(nested), root);
  }

  const TIER = taste(withFields({ name: 'release-tier', scope: 'external' }));

  test('the same name in two sources is the feature, not a duplicate', () => {
    const root = externalRoot({
      'agentkit-tastes/release-tier.md': TIER,
      'business-tastes/release-tier.md': TIER,
    });

    expect(lintTastePath(root)).toEqual([]);
  });

  test('a duplicate inside one source still fails, named by its source', () => {
    const root = externalRoot({
      'agentkit-tastes/release-tier.md': TIER,
      'agentkit-tastes/git/release-tier.md': TIER,
      'business-tastes/release-tier.md': TIER,
    });
    const errors = lintTastePath(root);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate');
    expect(errors[0]).toContain('agentkit-tastes/release-tier.md');
    expect(errors[0]).toContain('agentkit-tastes/git/release-tier.md');
  });

  test('an invalid taste is still reported, with the source it came from', () => {
    const root = externalRoot({
      'agentkit-tastes/release-tier.md': taste(withFields({ name: 'release-tiers' })),
    });
    const errors = lintTastePath(root);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('agentkit-tastes/release-tier.md');
    expect(errors[0]).toContain('filename');
  });

  // Nothing writes one and nothing reads one, so passing it over silently would
  // leave a file inside a linted tree that no run ever checked.
  test('a taste loose at the root belongs to no source and is refused', () => {
    const root = externalRoot({
      'agentkit-tastes/release-tier.md': TIER,
      'stray.md': TIER,
    });
    const errors = lintTastePath(root);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('stray.md');
    expect(errors[0]).toContain('source');
  });

  // One release of grace: a clone that predates the move still has its snapshot
  // at the old root, and pointing the linter at it must not read the whole tree
  // as one scope — which is the reading that turns two sources into a duplicate.
  test('the old tastes-vendor root is still read as a stack of sources', () => {
    const root = externalRoot({
      'agentkit-tastes/release-tier.md': TIER,
      'business-tastes/release-tier.md': TIER,
    }, 'tastes-vendor');

    expect(lintTastePath(root)).toEqual([]);
  });

  test('any other directory is one scope, exactly as before', () => {
    const root = join(sandbox({
      'tastes/release/tier.md': taste(withFields({ name: 'tier' })),
      'tastes/git/tier.md': taste(withFields({ name: 'tier' })),
    }), 'tastes');

    expect(lintTastePath(root)).toEqual(lintTasteDirectory(root));
    expect(lintTastePath(root)[0]).toContain('duplicate');
  });
});

describe('the frontmatter contract', () => {
  test('a file with no frontmatter is rejected', () => {
    const errors = lint({ 'release-tier.md': 'Cut patch releases by default.\n' });
    expect(errors).toHaveLength(1);
    // Distinct from the parse failure below: an absent block and a broken one
    // want different fixes, and reading only "frontmatter" cannot tell them apart.
    expect(errors[0]).toContain('no frontmatter');
  });

  test('frontmatter that does not parse is rejected with the parser error', () => {
    const errors = lint({ 'release-tier.md': '---\nname: [unclosed\n---\n\nbody\n' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('frontmatter does not parse');
  });

  test('each missing required key is named', () => {
    const errors = lint({
      'release-tier.md': taste({ name: 'release-tier', scope: 'project' }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('strength');
    expect(errors[0]).toContain('provenance');
  });

  test('an unknown top-level key is rejected rather than silently ignored', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({ name: 'release-tier', strenght: 'require' })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('strenght');
  });

  test('a body that says nothing is rejected', () => {
    const errors = lint({ 'release-tier.md': taste(withFields({ name: 'release-tier' }), '\n') });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('body');
  });

  test.each([
    ['scope', 'organisation', 'project'],
    ['strength', 'mandatory', 'require'],
    ['enforce', 'refuse', 'block'],
  ])('an invalid %s value is rejected and the accepted values named', (key, bad, good) => {
    const errors = lint({ 'release-tier.md': taste(withFields({ name: 'release-tier', [key]: bad })) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(key);
    expect(errors[0]).toContain(bad);
    expect(errors[0]).toContain(good);
  });
});

describe('the rule block is data, and only where it means something', () => {
  const RULE = "  kind: command\n  match: 'git tag'\n  remedy: Cut a patch tag.";

  test('a rule on an advise taste is rejected — nothing would ever read it', () => {
    const errors = lint({ 'release-tier.md': taste(withFields({ name: 'release-tier', rule: RULE })) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule');
    expect(errors[0]).toContain('advise');
  });

  test('an explicit enforce: advise with a rule is rejected the same way', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({ name: 'release-tier', enforce: 'advise', rule: RULE })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule');
  });

  test('enforce: block without a rule is rejected — the hook would have nothing to read', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({ name: 'release-tier', enforce: 'block' })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule');
    expect(errors[0]).toContain('block');
  });

  test('a match that is not a valid regular expression is rejected', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: "  kind: command\n  match: 'git tag ([0-9'\n  remedy: Cut a patch tag.",
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.match');
  });

  test('an unsupported rule kind is rejected', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: "  kind: thought\n  match: 'git tag'\n  remedy: Cut a patch tag.",
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.kind');
  });

  test('an override that is not a plain environment-variable name is rejected', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: `${RULE}\n  override: 'RELEASE_TIER=$(id -u)'`,
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.override');
  });

  test('a nested or non-string rule value is rejected — the block is data, not structure', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: "  kind: command\n  match:\n    - 'git tag'\n  remedy: Cut a patch tag.",
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.match');
  });

  test('an unknown rule key is rejected', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: `${RULE}\n  escalate: 'true'`,
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('escalate');
  });

  test('a remedy carrying a command substitution is rejected, and named as prose', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: "  kind: command\n  match: 'git tag'\n  remedy: 'Run $(rm -rf /) first.'",
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.remedy');
    // The message has to name the fix, not only the diagnosis: a remedy may well
    // want to mention a command, and the author needs to know how to write one.
    expect(errors[0]).toContain('plain prose');
    expect(errors[0]).toContain('without backticks');
  });

  test('a remedy carrying backticks is rejected the same way', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: "  kind: command\n  match: 'git tag'\n  remedy: 'Run `git tag` with a patch version.'",
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.remedy');
  });

  // format.md claims a rule carries no shell metacharacters. That claim covers
  // the whole block or it is not true, and match is the field an author is most
  // likely to paste a real command into.
  test('a match carrying a command substitution is rejected', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: "  kind: command\n  match: 'echo $(date)'\n  remedy: Cut a patch tag.",
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.match');
    expect(errors[0]).toContain('substitution');
  });

  test('a match carrying backticks is rejected, and told there is no escape for it', () => {
    const errors = lint({
      'release-tier.md': taste(withFields({
        name: 'release-tier',
        enforce: 'block',
        rule: "  kind: command\n  match: 'echo `date`'\n  remedy: Cut a patch tag.",
      })),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.match');
    // A backtick is one character: `\`` still contains one, so an escape hint
    // here would send the author around the same refusal forever.
    expect(errors[0]).toContain('backtick cannot appear');
  });

  function matchRule(pattern: string): Record<string, string> {
    return withFields({
      name: 'release-tier',
      enforce: 'block',
      rule: `  kind: command\n  match: '${pattern}'\n  remedy: Cut a patch tag.`,
    });
  }

  // The refusal names an escape, so the test performs that escape rather than
  // asserting a remembered one — a message advising something that does not work
  // is worse than a message advising nothing.
  test('the escape the match refusal names actually clears the refusal', () => {
    const refused = lint({ 'release-tier.md': taste(matchRule('echo $(date)')) });
    expect(refused).toHaveLength(1);

    const escape = /escape it as (\S+) to match/.exec(refused[0] as string)?.[1] as string;
    expect(escape, 'the refusal names an escape sequence').toBeDefined();

    // Two things have to hold, and the second alone is satisfied by any string
    // that happens not to trip the guard: the named escape must spell the
    // sequence being refused, and using it must clear the refusal.
    expect(escape.replaceAll('\\', ''), 'the escape spells the refused sequence').toBe('$(');
    expect(lint({ 'release-tier.md': taste(matchRule(`git tag ${escape}`)) })).toEqual([]);
  });

  test('an escaped substitution in a match is accepted — it is not the literal sequence', () => {
    expect(lint({ 'release-tier.md': taste(matchRule('git tag \\$\\(date\\)')) })).toEqual([]);
  });

  // The hook runs this pattern against every command, so an unrunnable one has
  // to fail here — where CI sees it — rather than in a session that then quietly
  // enforces nothing.
  describe('the pattern length cap', () => {
    const atCap = `git tag ${'a'.repeat(MAX_MATCH_LENGTH - 8)}`;

    test('a pattern at the cap is accepted', () => {
      expect(atCap).toHaveLength(MAX_MATCH_LENGTH);
      expect(lint({ 'release-tier.md': taste(matchRule(atCap)) })).toEqual([]);
    });

    test('one character more is refused, and told the cap', () => {
      const errors = lint({ 'release-tier.md': taste(matchRule(`${atCap}a`)) });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('rule.match');
      expect(errors[0]).toContain(String(MAX_MATCH_LENGTH));
    });
  });
});

describe('the command-line surface', () => {
  function run(dir: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [linter, dir], { encoding: 'utf8', timeout: 30_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test('a clean folder exits zero and says what it checked', () => {
    const result = run(sandbox(documentedTastes()));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 taste');
  });

  test('a violation exits non-zero and prints the message', () => {
    const result = run(sandbox({ 'release-tier.md': taste(withFields({ name: 'release-tiers' })) }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('filename');
  });

  test('a directory that does not exist is a usage error, not a clean run', () => {
    const result = run(join(tmpdir(), 'agentkit-tastes-does-not-exist'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no such directory');
  });

  // This repository's own tastes root, whose two sources both define
  // release-tier. Pointing the linter at the root is what a human or an agent
  // does, and it has to agree with what resolution already does with it.
  test('this repository\'s tastes root lints clean, both sources at once', () => {
    const result = run(join(repoRoot, '.agentkit', 'tastes'));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tastes checked, all valid');
  });
});
