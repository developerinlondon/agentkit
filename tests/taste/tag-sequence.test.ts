import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KindRequest, MatchOutcome } from '../../skills/taste/scripts/rules/kinds.ts';
import { proposedTags } from '../../skills/taste/scripts/rules/tag-command.ts';
import {
  GIT_TAG_SEQUENCE,
  judgeTag,
  TAG_POLICIES,
} from '../../skills/taste/scripts/rules/tag-sequence.ts';

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    rmSync(sandboxes.pop() as string, { recursive: true, force: true });
  }
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-tag-sequence-'));
  sandboxes.push(root);
  return root;
}

function git(dir: string, ...args: string[]): { code: number; err: string } {
  const result = Bun.spawnSync({
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
  return { code: result.exitCode ?? -1, err: result.stderr.toString() };
}

// A repository with a commit to hang tags on. Tags are what the check reads, so
// every integration case below differs only in which ones exist.
function repo(tags: string[]): string {
  const dir = scratch();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'file.txt'), 'contents');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  for (const tag of tags) git(dir, 'tag', tag);
  return dir;
}

// A git that fails the way we need it to. Dubious ownership needs a checkout
// owned by another uid, which a test cannot make; what the code reads is the
// exit status and the message, and those a stub reproduces exactly.
function stubGit(message: string, code: number): string {
  const dir = scratch();
  const path = join(dir, 'git');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(message)} >&2\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return dir;
}

// A git that answers in the session's language unless it is asked in C — which
// is what a translated git on a developer's machine does, and what would make
// the sentence above unrecognisable.
function translatedGit(): string {
  const dir = scratch();
  const path = join(dir, 'git');
  writeFileSync(
    path,
    '#!/bin/sh\n'
      + 'if [ "$LC_ALL" = C ]; then\n'
      + "  printf '%s\\n' 'fatal: not a git repository (or any parent up to mount point /)' >&2\n"
      + 'else\n'
      + "  printf '%s\\n' 'fatal: kein Git-Repository (oder eines der übergeordneten Verzeichnisse)' >&2\n"
      + 'fi\n'
      + 'exit 128\n',
  );
  chmodSync(path, 0o755);
  return dir;
}

// The rule never reaches this in the default path: the shapes agentkit
// recognises are its own code, and only an overriding rule.match is matched.
function refuseToMatch(): Promise<MatchOutcome> {
  throw new Error('the default extraction must not use the bounded matcher');
}

function evaluate(
  fields: Record<string, string>,
  command: string,
  cwd: string,
  options: { match?: () => Promise<MatchOutcome>; env?: Record<string, string> } = {},
) {
  const request: KindRequest = {
    command,
    cwd,
    env: options.env ?? { PATH: process.env.PATH },
    match: (options.match ?? refuseToMatch) as KindRequest['match'],
  };
  return GIT_TAG_SEQUENCE.evaluate(fields, request);
}

describe('the proposed tag is read out of the command', () => {
  test.each([
    ['a plain tag', 'git tag v1.2.3', ['v1.2.3']],
    ['an annotated tag', 'git tag -a v1.2.3 -m "release"', ['v1.2.3']],
    ['a signed tag', 'git tag -s v1.2.3 -m "release"', ['v1.2.3']],
    ['a tag on a named commit', 'git tag v1.2.3 abc1234', ['v1.2.3']],
    ['a quoted tag', 'git tag "v1.2.3"', ['v1.2.3']],
    ['git run from another directory', 'git -C /srv/repo tag v1.2.3', ['v1.2.3']],
    ['a push of one tag', 'git push origin v1.2.3', ['v1.2.3']],
    ['a push by full ref', 'git push origin refs/tags/v1.2.3', ['v1.2.3']],
    ['a push with an explicit refspec', 'git push origin v1.2.3:refs/tags/v1.2.3', ['v1.2.3']],
    ['a release created on the forge', 'gh release create v1.2.3 --notes ok', ['v1.2.3']],
    ['a tag later in a chain', 'bun test && git tag v1.2.3', ['v1.2.3']],
    ['an inline override assignment', 'AGENTKIT_TAGS=1 git tag v1.2.3', ['v1.2.3']],
  ])('reads %s', (_shape, command, expected) => {
    expect(proposedTags(command)).toEqual(expected);
  });

  test.each([
    ['listing tags', 'git tag --list'],
    ['listing with a pattern', 'git tag -l "v1.*"'],
    ['deleting a tag', 'git tag -d v1.2.3'],
    ['deleting a remote tag', 'git push origin --delete v1.2.3'],
    ['verifying a tag', 'git tag -v v1.2.3'],
    ['pushing a branch', 'git push origin main'],
    ['pushing every tag with none named', 'git push --tags'],
    ['a message that merely mentions a version', 'git commit -m "bump to v1.2.3"'],
    ['viewing a release', 'gh release view v1.2.3'],
    ['a wholly unrelated command', 'bun test'],
  ])('proposes nothing for %s', (_shape, command) => {
    expect(proposedTags(command)).toEqual([]);
  });

  // A tag message is prose, and prose splits on nothing: a quoted separator is
  // one token, so the tag after it is still read.
  test('a quoted separator inside a message does not hide the tag', () => {
    expect(proposedTags('git tag -m "fixes a|b; and c" v1.2.3')).toEqual(['v1.2.3']);
  });

  // The shell hands `-ma;b` to git as one argument, so the tag really is
  // created. A quote opening partway through a word therefore has to keep that
  // word together, exactly as a quote that opens it does.
  test.each([
    ['a double-quoted message attached to -m', 'git tag -m"a;b" v1.2.3'],
    ['a single-quoted message attached to -m', "git tag -m'a|b' v1.2.3"],
    ['an attached message carrying &&', 'git tag -m"a&&b" v1.2.3'],
    ['an attached long-option message', 'git tag --message"a;b" v1.2.3'],
  ])('reads the tag past %s', (_shape, command) => {
    expect(proposedTags(command)).toEqual(['v1.2.3']);
  });

  // And the version named in the message is not the tag being cut. Reading it
  // as one would refuse the release on the strength of its own release note.
  test('a version mentioned inside an attached message is not proposed', () => {
    expect(proposedTags('git tag -m"v0.8.0 fixes A; adds B" v0.7.12')).toEqual(['v0.7.12']);
  });

  // A backslash is how a shell keeps the next character out of the grammar, so
  // it has to keep it out of this one too — an escaped quote does not close the
  // message, and an escaped separator does not end the command.
  test.each([
    ['an escaped quote inside a quoted message', 'git tag -m "a\\"b; c" v1.2.3'],
    ['an escaped quote inside an attached message', 'git tag -m"a\\"b; c" v1.2.3'],
    ['an escaped separator outside any quotes', 'git tag -m a\\;b v1.2.3'],
    ['an escaped quote then a real one', 'git tag -m "a\\" b" v1.2.3'],
  ])('reads the tag past %s', (_shape, command) => {
    expect(proposedTags(command)).toEqual(['v1.2.3']);
  });

  test('a version inside an escaped-quote message is still not the tag', () => {
    expect(proposedTags('git tag -m "v0.8.0 \\"quoted\\"; more" v0.7.12')).toEqual(['v0.7.12']);
  });

  // The option consumed a word that happens to parse as a version. Reading it
  // as a proposal refuses a legitimate release on the strength of its own
  // message, so the value has to be stepped over.
  test.each([
    ['a bare message value', 'git tag -m v0.8.0 v0.7.12'],
    ['a bare long-option value', 'git tag --message v0.8.0 v0.7.12'],
    ['a push option value', 'git push origin --receive-pack v0.8.0 v0.7.12'],
    ['a forge release note value', 'gh release create v0.7.12 --notes v0.8.0'],
  ])('steps over %s', (_shape, command) => {
    expect(proposedTags(command)).toEqual(['v0.7.12']);
  });

  // An attached value is self-contained, so nothing after it may be skipped.
  test('an attached option value does not swallow the tag after it', () => {
    expect(proposedTags('git tag --message=v0.8.0 v0.7.12')).toEqual(['v0.7.12']);
  });
});

describe('each policy names what it refuses', () => {
  const EXISTING = ['v0.6.2', 'v0.6.5', 'v0.7.0', 'v0.7.11', 'not-a-version', 'release-2026'];

  // One table, read as: this tag, proposed against those tags, under this
  // policy. `undefined` is an allow; a string is the finding in the refusal.
  test.each([
    ['no-duplicate', 'v0.7.11', false, 'already exists'],
    ['no-duplicate', 'v0.1.1', true, ''],
    ['no-duplicate', 'v0.6.3', true, ''],
    ['no-duplicate', 'v9.9.9', true, ''],
    ['no-backwards-in-line', 'v0.7.11', false, 'already exists'],
    ['no-backwards-in-line', 'v0.6.5', false, 'already exists'],
    // The maintenance line the owner keeps: 0.6.6 is ahead on its own line even
    // though 0.7.11 is the highest tag in the repository.
    ['no-backwards-in-line', 'v0.6.6', true, ''],
    ['no-backwards-in-line', 'v0.6.3', false, 'v0.6.5'],
    ['no-backwards-in-line', 'v0.7.12', true, ''],
    ['no-backwards-in-line', 'v0.5.9', true, ''],
    ['strict-successor', 'v0.7.12', true, ''],
    ['strict-successor', 'v0.7.11', false, 'already exists'],
    ['strict-successor', 'v0.6.6', false, 'v0.7.11'],
    ['strict-successor', 'v0.7.13', false, 'v0.7.12'],
    ['strict-successor', 'v0.8.0', false, 'v0.7.12'],
    ['strict-successor', 'v1.0.0', false, 'v0.7.12'],
  ])('%s %s allowed=%p', (policy, tag, allowed, phrase) => {
    const finding = judgeTag(policy as string, tag, EXISTING);
    if (allowed) {
      expect(finding, `${policy} must allow ${tag}`).toBeUndefined();
      return;
    }
    expect(finding, `${policy} must refuse ${tag}`).toBeDefined();
    expect(finding).toContain(tag);
    expect(finding).toContain(phrase);
  });

  // The case the issue turns on, asserted on its own so a table edit cannot
  // quietly drop it: a lower line is maintenance, not a mistake.
  test('v0.6.5 while v0.7.11 exists is allowed in its line and refused as a successor', () => {
    const existing = ['v0.7.11'];
    expect(judgeTag('no-backwards-in-line', 'v0.6.5', existing)).toBeUndefined();
    expect(judgeTag('strict-successor', 'v0.6.5', existing)).toContain('v0.7.11');
  });

  test.each(TAG_POLICIES)('%s ignores a tag that is not semver', (policy) => {
    expect(judgeTag(policy, 'nightly', ['v1.0.0', 'nightly'])).toBeUndefined();
    expect(judgeTag(policy, 'v1.2', ['v1.0.0'])).toBeUndefined();
  });

  test.each(TAG_POLICIES)('%s has nothing to say when no semver tag exists', (policy) => {
    expect(judgeTag(policy, 'v1.0.0', ['nightly', 'latest'])).toBeUndefined();
  });

  // Ordering is semver's, not the string's: 11 is above 9, and a prerelease
  // sits below the release it leads to.
  test('the highest tag is read by semver precedence rather than alphabetically', () => {
    expect(judgeTag('strict-successor', 'v0.7.10', ['v0.7.9', 'v0.7.11'])).toContain('v0.7.11');
    expect(judgeTag('strict-successor', 'v0.7.12', ['v0.7.9', 'v0.7.11'])).toBeUndefined();
  });

  // Documented in format.md, so it is asserted here: strict-successor accepts
  // the next patch and nothing else, which means it cannot open a new minor
  // line even as a release candidate.
  test('strict-successor refuses a prerelease that opens a new line', () => {
    const finding = judgeTag('strict-successor', 'v0.8.0-rc1', ['v0.7.11']);

    expect(finding).toContain('v0.8.0-rc1');
    expect(finding).toContain('v0.7.12');
  });

  test('a prerelease sorts below its release and may still graduate', () => {
    expect(judgeTag('strict-successor', 'v0.8.0', ['v0.8.0-rc1'])).toBeUndefined();
    expect(judgeTag('strict-successor', 'v0.8.0-rc2', ['v0.8.0-rc1'])).toBeUndefined();
    expect(judgeTag('no-backwards-in-line', 'v0.8.0-rc1', ['v0.8.0'])).toContain('v0.8.0');
  });

  test('an unknown policy refuses nothing rather than guessing one', () => {
    expect(judgeTag('whatever-comes-next', 'v0.1.1', ['v9.9.9'])).toBeUndefined();
  });

  // A name off Object.prototype resolves to a function on any plain-object
  // lookup. The lint refuses such a policy long before this, which is exactly
  // why the guard belongs here too: the hook's safety must not rest on a check
  // two modules away.
  test.each([['constructor'], ['toString'], ['__proto__'], ['hasOwnProperty']])(
    'a policy named %p is not a judge',
    (policy) => {
      expect(judgeTag(policy, 'v0.1.1', ['v9.9.9'])).toBeUndefined();
    },
  );
});

describe('the check reads the repository the command runs in', () => {
  test('a tag that goes backwards is refused, naming the tag it is behind', async () => {
    const dir = repo(['v0.6.2', 'v0.6.5']);
    const outcome = await evaluate({ policy: 'no-backwards-in-line' }, 'git tag v0.6.3', dir);

    expect(outcome.verdict).toBe('fires');
    expect(outcome.verdict === 'fires' && outcome.finding).toContain('v0.6.5');
    expect(outcome.verdict === 'fires' && outcome.finding).toContain('no-backwards-in-line');
  });

  test('a tag that goes forwards on its own line passes', async () => {
    const dir = repo(['v0.6.5', 'v0.7.11']);
    const outcome = await evaluate({ policy: 'no-backwards-in-line' }, 'git tag v0.6.6', dir);

    expect(outcome.verdict).toBe('passes');
  });

  test('a directory that is not a git repository has nothing to check', async () => {
    const outcome = await evaluate({ policy: 'strict-successor' }, 'git tag v0.1.1', scratch());

    expect(outcome.verdict).toBe('passes');
  });

  test('a repository with no tags at all has nothing to check', async () => {
    const outcome = await evaluate({ policy: 'strict-successor' }, 'git tag v9.9.9', repo([]));

    expect(outcome.verdict).toBe('passes');
  });

  // Not a silent allow. The command runs, and the session is told the guard did
  // not see the state it needed — the same contract the hook itself keeps.
  test('tags that cannot be listed report UNCHECKED and allow', async () => {
    const dir = repo(['v0.7.11']);
    // A ref database git refuses to read: the repository is real, so this is
    // not the not-a-repository case, and the tags genuinely cannot be listed.
    writeFileSync(join(dir, '.git', 'packed-refs'), 'this file is not a ref database\n');

    const outcome = await evaluate({ policy: 'strict-successor' }, 'git tag v0.1.1', dir);

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' && outcome.detail).toContain('git');
  });

  // Only git's own "not a git repository" is evidence of that. Every other
  // failure — dubious ownership under a CI uid, a corrupt repository, a
  // permission error — is a guard that could not look, and must say so.
  test.each([
    ["fatal: detected dubious ownership in repository at '/src'", 'dubious ownership'],
    ['fatal: cannot change to \'/src\': Permission denied', 'Permission denied'],
    ['fatal: not a git repository: \'/src/.git\'', '/src/.git'],
  ])('a rev-parse failure saying %p is UNCHECKED, not a silent pass', async (message, phrase) => {
    const outcome = await evaluate({ policy: 'strict-successor' }, 'git tag v0.1.1', scratch(), {
      env: { PATH: stubGit(message, 128) },
    });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' && outcome.detail).toContain(phrase);
  });

  // Both phrasings git uses when discovery simply found nothing. The one it
  // prints depends on whether the walk stopped at a mount point, so pinning
  // only one of them would silently turn half the real cases into UNCHECKED.
  test.each([
    ['fatal: not a git repository (or any of the parent directories): .git'],
    ['fatal: not a git repository (or any parent up to mount point /)'],
  ])('git saying %p passes silently', async (message) => {
    const outcome = await evaluate({ policy: 'strict-successor' }, 'git tag v0.1.1', scratch(), {
      env: { PATH: stubGit(message, 128) },
    });

    expect(outcome.verdict).toBe('passes');
  });

  // Otherwise a translated git turns every directory without a repository into
  // an UNCHECKED notice, on every tag command, for the whole session.
  test('git is asked in C, so a translated session still reads as not-a-repository', async () => {
    const outcome = await evaluate({ policy: 'strict-successor' }, 'git tag v0.1.1', scratch(), {
      env: { PATH: translatedGit(), LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' },
    });

    expect(outcome.verdict).toBe('passes');
  });

  // A missing git is not evidence that this is not a repository, so it must not
  // land on the silent pass that "not a repository" gets.
  test('git that cannot be run at all is UNCHECKED rather than a pass', async () => {
    const dir = repo(['v0.7.11']);
    const outcome = await evaluate({ policy: 'strict-successor' }, 'git tag v0.1.1', dir, {
      env: { PATH: '/agentkit-nonexistent' },
    });

    expect(outcome.verdict).toBe('unchecked');
  });

  test('a command proposing no tag never asks git anything', async () => {
    const outcome = await evaluate({ policy: 'strict-successor' }, 'bun test', '/nonexistent');

    expect(outcome.verdict).toBe('passes');
  });
});

describe('an unregistered policy stops the taste rather than the hook', () => {
  test.each([['whatever-comes-next'], ['constructor']])(
    'policy %p is skipped, by name, and the command is allowed',
    async (policy) => {
      const outcome = await evaluate({ policy }, 'git tag v0.1.1', repo(['v0.7.11']));

      expect(outcome.verdict).toBe('skipped');
      expect(outcome.verdict === 'skipped' && outcome.detail).toContain(policy);
      for (const known of TAG_POLICIES) {
        expect(outcome.verdict === 'skipped' && outcome.detail).toContain(known);
      }
    },
  );
});

describe('rule.match overrides how the tag is read', () => {
  test('the first capture group is the proposed tag', async () => {
    const dir = repo(['v0.7.11']);
    const matcher = async () => ({ matched: true, captures: ['v0.1.1'] });
    const outcome = await evaluate(
      { policy: 'strict-successor', match: 'release ([^ ]+)' },
      'ship release v0.1.1',
      dir,
      { match: matcher },
    );

    expect(outcome.verdict).toBe('fires');
    expect(outcome.verdict === 'fires' && outcome.finding).toContain('v0.1.1');
  });

  test('a pattern that cannot be run skips the taste rather than refusing', async () => {
    const dir = repo(['v0.7.11']);
    const matcher = async () => ({ skipped: 'its rule.match did not finish' });
    const outcome = await evaluate(
      { policy: 'strict-successor', match: '(a+)+$' },
      'git tag v0.1.1',
      dir,
      { match: matcher },
    );

    expect(outcome.verdict).toBe('skipped');
  });
});

describe('the lint reads what this kind requires', () => {
  test('the kind declares its own fields', () => {
    expect(GIT_TAG_SEQUENCE.name).toBe('git-tag-sequence');
    expect(GIT_TAG_SEQUENCE.required).toEqual(['policy']);
    expect(GIT_TAG_SEQUENCE.optional).toEqual(['match']);
  });

  test('a policy outside the enum is refused, naming the ones that exist', () => {
    const errors = GIT_TAG_SEQUENCE.validate({ policy: 'no-backwards', remedy: 'Cut a patch.' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.policy');
    for (const policy of TAG_POLICIES) expect(errors[0]).toContain(policy);
  });

  test.each(TAG_POLICIES)('%s passes the lint', (policy) => {
    expect(GIT_TAG_SEQUENCE.validate({ policy })).toEqual([]);
  });

  test('an overriding match is held to the same bounds as a command rule', () => {
    const errors = GIT_TAG_SEQUENCE.validate({ policy: 'no-duplicate', match: 'git tag ([0-9' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.match');
  });
});
