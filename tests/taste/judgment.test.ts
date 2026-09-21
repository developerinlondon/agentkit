import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintTasteDirectory, onKeyErrors, ruleFields } from '../../skills/taste/scripts/lint.ts';
import { resolveTastes } from '../../skills/taste/scripts/resolve.ts';
import { evaluateCommand } from '../../skills/taste/scripts/police.ts';
import {
  JUDGMENT_BUDGET_MS,
  JUDGMENT_CALL_MS,
} from '../../skills/taste/scripts/rules/budget.ts';
import { JUDGMENT } from '../../skills/taste/scripts/rules/judgment.ts';
import type { KindRequest, MatchOutcome } from '../../skills/taste/scripts/rules/kinds.ts';

// Nothing here may reach api.typesafe.ai. Port 9 is discard: a test that
// forgets its stub fails on a refused connection rather than on the vendor.
const NOWHERE = 'http://127.0.0.1:9';

const POLICY = 'No stopgaps.\n\nWhy: a workaround left in place is the next outage.\n\n'
  + 'How to apply: fix the cause, or say why the workaround is the fix.';
const QUESTION = 'Does this change ship a workaround that leaves the real fix for later?';

const sandboxes: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];

afterEach(() => {
  while (servers.length > 0) (servers.pop() as { stop(force?: boolean): void }).stop(true);
  while (sandboxes.length > 0) rmSync(sandboxes.pop() as string, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-judgment-'));
  sandboxes.push(root);
  return root;
}

function git(dir: string, ...args: string[]): void {
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
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

// A repository whose one staged change is the thing the judgment reads.
function repo(options: { staged?: boolean; marker?: string } = {}): string {
  const marker = options.marker ?? 'stopgap until the fix';
  const dir = scratch();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'retry.ts'), 'export const retries = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  if (options.staged === false) return dir;
  writeFileSync(join(dir, 'retry.ts'), `export const retries = 1; // ${marker}\n`);
  git(dir, 'add', '-A');
  return dir;
}

interface Body {
  model: string;
  state: Record<string, string>;
  questions: Record<string, { type: string; instructions: Record<string, string> }>;
}

interface Sent {
  body: Body;
  authorization: string | null;
}

interface Stub {
  url: string;
  sent: Sent[];
}

function provider(options: { noul?: number; status?: number; hang?: boolean } = {}): Stub {
  const sent: Sent[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request) {
      sent.push({
        body: await request.json() as Body,
        authorization: request.headers.get('authorization'),
      });
      if (options.hang === true) return await new Promise<Response>(() => {});
      if (options.status !== undefined) return new Response('refused', { status: options.status });
      return Response.json({
        model: 'jev-1.13.0',
        answers: { q: { type: 'noul', noul: options.noul ?? 0 } },
        usage: { input_tokens: 307, output_tokens: 20 },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, sent };
}

// A git that answers nothing and writes down that it was asked. The verdict
// alone cannot tell a check that never ran from one that ran and found nothing,
// so whether git was reached at all is observed rather than inferred.
function recordingGit(): { dir: string; asked: () => boolean } {
  const dir = scratch();
  const marker = join(dir, 'asked');
  const path = join(dir, 'git');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(path, 0o755);
  return { dir, asked: () => existsSync(marker) };
}

function refuseToMatch(): Promise<MatchOutcome> {
  throw new Error('a judgment rule never compiles a pattern');
}

interface Options {
  command?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  body?: string;
  url?: string;
}

function evaluate(fields: Record<string, string>, options: Options = {}) {
  const home = scratch();
  const request: KindRequest = {
    command: options.command ?? 'git commit -m "paper over the retry"',
    cwd: options.cwd ?? repo(),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      TYPESAFE_API_KEY: 'sk-test',
      TYPESAFE_BASE_URL: options.url ?? NOWHERE,
      ...options.env,
    },
    match: refuseToMatch as KindRequest['match'],
    body: options.body ?? POLICY,
  };
  return JUDGMENT.evaluate({ question: QUESTION, ...fields }, request);
}

describe('a judgment reaches the provider and its probability decides', () => {
  test('a noul at or above the threshold refuses, and says how sure it was', async () => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, { url: stub.url });

    expect(outcome.verdict).toBe('fires');
    expect(outcome.verdict === 'fires' ? outcome.finding : '').toContain('p=0.9');
    expect(stub.sent).toHaveLength(1);
  });

  test('a noul below the threshold passes', async () => {
    const stub = provider({ noul: 0.2 });

    expect((await evaluate({}, { url: stub.url })).verdict).toBe('passes');
  });

  test('the taste\'s own threshold is what the noul is read against', async () => {
    const stub = provider({ noul: 0.6 });
    const outcome = await evaluate({ threshold: '0.5' }, { url: stub.url });

    expect(outcome.verdict).toBe('fires');
  });

  test('0.6 is below the default threshold, so the same answer passes without one', async () => {
    const stub = provider({ noul: 0.6 });

    expect((await evaluate({}, { url: stub.url })).verdict).toBe('passes');
  });

  // The comparison is "at or above", and only a noul exactly on the threshold
  // tells that apart from "above".
  test('a noul exactly on the threshold fires, and one just under it passes', async () => {
    const onIt = provider({ noul: 0.75 });
    expect((await evaluate({ threshold: '0.75' }, { url: onIt.url })).verdict).toBe('fires');

    const under = provider({ noul: 0.7499 });
    expect((await evaluate({ threshold: '0.75' }, { url: under.url })).verdict).toBe('passes');
  });

  test('the call carries the diff, the message, the taste body and the question', async () => {
    const stub = provider({ noul: 0.1 });
    await evaluate({}, { url: stub.url });
    const body = stub.sent[0]?.body as Body;

    expect(body.model).toBe('jev-latest');
    expect(stub.sent[0]?.authorization).toBe('Bearer sk-test');
    expect(body.state.command).toContain('git commit');
    expect(body.state.message).toBe('paper over the retry');
    expect(body.state.diff).toContain('stopgap until the fix');
    expect(body.questions.q?.type).toBe('noul');
    expect(body.questions.q?.instructions.question).toBe(QUESTION);
    expect(body.questions.q?.instructions.policy).toBe(POLICY);
  });
});

describe('what the rule judges, and what it leaves alone', () => {
  // The path every ordinary command takes, so it must cost nothing. A cwd with
  // no repository in it is the assertion: had git been consulted at all, the
  // verdict would be UNCHECKED rather than a pass.
  test('a command that is not a commit passes without reading anything', async () => {
    const stub = provider({ noul: 0.99 });
    const git = recordingGit();
    const outcome = await evaluate({}, {
      command: 'bun test tests/taste',
      cwd: scratch(),
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}`, TYPESAFE_API_KEY: undefined },
    });

    expect(outcome.verdict).toBe('passes');
    expect(git.asked()).toBe(false);
    expect(stub.sent).toHaveLength(0);
  });

  // The control for the case above: the same stub, a command that is in scope,
  // and git reached. Without it, a kind that never ran git would pass both.
  test('a commit does reach git', async () => {
    const stub = provider({ noul: 0.99 });
    const git = recordingGit();
    await evaluate({}, {
      cwd: scratch(),
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}`, TYPESAFE_API_KEY: undefined },
    });

    expect(git.asked()).toBe(true);
  });

  test('a merge request is judged when the taste says so, and not otherwise', async () => {
    const asked = provider({ noul: 0.99 });
    const fired = await evaluate({ on: 'merge-request' }, {
      command: 'gh pr create --fill',
      url: asked.url,
    });

    expect(fired.verdict).toBe('fires');
    expect(asked.sent).toHaveLength(1);

    const quiet = provider({ noul: 0.99 });
    const git = recordingGit();
    const outcome = await evaluate({}, {
      command: 'gh pr create --fill',
      cwd: scratch(),
      url: quiet.url,
      env: { PATH: `${git.dir}:${process.env.PATH}`, TYPESAFE_API_KEY: undefined },
    });

    expect(outcome.verdict).toBe('passes');
    expect(git.asked()).toBe(false);
    expect(quiet.sent).toHaveLength(0);
  });

  test('a merge-request rule leaves a commit alone, and reads nothing', async () => {
    const stub = provider({ noul: 0.99 });
    const git = recordingGit();
    const outcome = await evaluate({ on: 'merge-request' }, {
      command: 'git commit -m "a change"',
      cwd: scratch(),
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}`, TYPESAFE_API_KEY: undefined },
    });

    expect(outcome.verdict).toBe('passes');
    expect(git.asked()).toBe(false);
    expect(stub.sent).toHaveLength(0);
  });

  test('on: any judges the command with no diff to read', async () => {
    const stub = provider({ noul: 0.99 });
    const outcome = await evaluate({ on: 'any' }, {
      command: 'rm -rf /srv/cache',
      cwd: scratch(),
      url: stub.url,
    });
    expect(outcome.verdict).toBe('fires');
    expect(stub.sent[0]?.body.state.diff).toBe('');
  });

  test('a commit with nothing staged passes without asking', async () => {
    const stub = provider({ noul: 0.99 });
    const outcome = await evaluate({}, { cwd: repo({ staged: false }), url: stub.url });

    expect(outcome.verdict).toBe('passes');
    expect(stub.sent).toHaveLength(0);
  });

  test('a diff past the cap is cut, and says where', async () => {
    const dir = repo({ staged: false });
    const rows = JSON.stringify('x'.repeat(40000));
    writeFileSync(join(dir, 'wide.ts'), `export const rows = ${rows};\n`);
    git(dir, 'add', '-A');
    const stub = provider({ noul: 0.1 });
    await evaluate({}, { cwd: dir, url: stub.url });
    const diff = (stub.sent[0]?.body.state as Record<string, string>).diff as string;

    expect(diff.endsWith('[diff truncated]')).toBe(true);
    expect(diff.length).toBeLessThan(12100);
  });

  test('a long commit message is cut, and says where', async () => {
    const stub = provider({ noul: 0.1 });
    await evaluate({}, { command: `git commit -m "${'word '.repeat(600)}"`, url: stub.url });
    const message = stub.sent[0]?.body.state.message as string;

    expect(message.endsWith('[message truncated]')).toBe(true);
    expect(message.length).toBeLessThan(2100);
  });

  // An amend with nothing staged rewrites the message, which is the whole of
  // the change and the thing a taste about commit messages judges.
  test('an amend with nothing staged is judged on its message', async () => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, {
      command: 'git commit --amend -m "a better message"',
      cwd: repo({ staged: false }),
      url: stub.url,
    });

    expect(outcome.verdict).toBe('fires');
    expect(stub.sent[0]?.body.state.message).toBe('a better message');
    expect(stub.sent[0]?.body.state.diff).toBe('');
  });

  // The amend exception is the message, so an amend carrying no message and
  // nothing staged is no evidence at all. Judging it refuses on whatever the
  // provider happens to return.
  test('a bare amend with nothing staged is not judged', async () => {
    const stub = provider({ noul: 0.9 });
    const git = recordingGit();
    const outcome = await evaluate({}, {
      command: 'git commit --amend',
      cwd: scratch(),
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}`, TYPESAFE_API_KEY: undefined },
    });

    expect(outcome.verdict).toBe('passes');
    expect(stub.sent).toHaveLength(0);
  });

  test('an amend whose message is only whitespace is not judged either', async () => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, {
      command: 'git commit --amend -m "   "',
      cwd: repo({ staged: false }),
      url: stub.url,
    });

    expect(outcome.verdict).toBe('passes');
    expect(stub.sent).toHaveLength(0);
  });

  test('git commit -a is judged on the working tree rather than the index', async () => {
    const dir = repo({ staged: false });
    writeFileSync(join(dir, 'retry.ts'), 'export const retries = 1; // stopgap until the fix\n');
    const stub = provider({ noul: 0.1 });
    await evaluate({}, { command: 'git commit -am "paper over it"', cwd: dir, url: stub.url });
    const state = stub.sent[0]?.body.state as Record<string, string>;

    expect(state.diff).toContain('stopgap until the fix');
    expect(state.message).toBe('paper over it');
  });
});

describe('the repository judged is the one the command targets', () => {
  test('git -C names the repository, not the directory the hook runs in', async () => {
    const here = repo({ marker: 'the wrong repository' });
    const there = repo({ marker: 'the right repository' });
    const stub = provider({ noul: 0.1 });
    await evaluate({}, {
      command: `git -C ${there} commit -m "over there"`,
      cwd: here,
      url: stub.url,
    });
    const state = stub.sent[0]?.body.state as Record<string, string>;

    expect(state.diff).toContain('the right repository');
    expect(state.diff).not.toContain('the wrong repository');
  });

  test('a relative git -C resolves against the directory the command runs in', async () => {
    const root = repo({ marker: 'the outer repository' });
    const inner = join(root, 'inner');
    mkdirSync(inner, { recursive: true });
    git(inner, 'init', '-q', '-b', 'main');
    writeFileSync(join(inner, 'a.ts'), 'export const a = 1; // the inner repository\n');
    git(inner, 'add', '-A');
    const stub = provider({ noul: 0.1 });
    await evaluate({}, { command: 'git -C inner commit -m "in there"', cwd: root, url: stub.url });
    const state = stub.sent[0]?.body.state as Record<string, string>;

    expect(state.diff).toContain('the inner repository');
  });

  // The reason matters as much as the verdict: git failing on a path it cannot
  // find also reports UNCHECKED, and that would pass this test while the
  // command was read wrongly rather than refused.
  test.each([
    ['a cd to a path not spelled out', 'cd "$T" && git commit -m "x"', 'changes directory'],
    ['a cd with a glob', 'cd build-* && git commit -m "x"', 'changes directory'],
    ['a pushd before the commit', 'pushd elsewhere && git commit -m "x"', 'changes directory'],
    ['a cd with no argument at all', 'cd && git commit -m "x"', 'changes directory'],
    ['a cd with an option', 'cd -P inner && git commit -m "x"', 'changes directory'],
    ['a commit naming its own git dir', 'git --git-dir=/o/.git commit -m "x"', '--git-dir'],
    ['a commit naming its own work tree', 'git --work-tree=/o commit -m "x"', '--work-tree'],
    ['a bash -c on text built at run time', 'bash -c "$CMD"', 'bash -c'],
    ['an eval on text built at run time', 'eval "$CMD"', 'eval'],
    ['a message spliced in by the shell', 'sh -c "git commit -m $MSG"', 'sh -c'],
    ['a wrapped command holding a substitution', 'bash -c "git commit -m `date`"', 'bash -c'],
    ['a wrapper quoted inside a wrapper', 'bash -c "bash -c \\"git commit -m x\\""', 'quot'],
    ['a wrapper whose quoting never closes', 'bash -c \'git commit -m "oops', 'quot'],
    ['wrappers nested past what this reads', 'eval eval eval eval git commit -m x', 'deep'],
  ])('%s is UNCHECKED, and says which', async (_shape, command, because) => {
    const stub = provider({ noul: 0.99 });
    const git = recordingGit();
    const outcome = await evaluate({}, {
      command,
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}` },
    });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' ? outcome.detail : '').toContain(because);
    expect(git.asked()).toBe(false);
    expect(stub.sent).toHaveLength(0);
  });

  // The directory is right there in the command, so reading it is not a guess.
  test.each([
    ['a literal cd', 'cd inner && git commit -m "in there"'],
    ['a literal cd inside a subshell', '(cd inner && git commit -m "in there")'],
  ])('%s names the repository as surely as git -C does', async (_shape, command) => {
    const root = repo({ marker: 'the outer repository' });
    const inner = join(root, 'inner');
    mkdirSync(inner, { recursive: true });
    git(inner, 'init', '-q', '-b', 'main');
    writeFileSync(join(inner, 'a.ts'), 'export const a = 1; // the inner repository\n');
    git(inner, 'add', '-A');
    const stub = provider({ noul: 0.1 });
    await evaluate({}, { command, cwd: root, url: stub.url });
    const state = stub.sent[0]?.body.state as Record<string, string>;

    expect(state.diff).toContain('the inner repository');
  });

  // Read by the override short-circuit before anything runs, so it answers off
  // the command text alone. An occasion it does not know applies to nothing.
  test.each([
    ['a commit under the default occasion', {}, 'git commit -m "x"', true],
    ['another command under the default', {}, 'git status', false],
    ['a merge request under its occasion', { on: 'merge-request' }, 'gh pr create', true],
    ['a commit under the merge-request occasion', { on: 'merge-request' }, 'git commit', false],
    ['anything at all under any', { on: 'any' }, 'ls', true],
    ['an occasion no version of this knows', { on: 'sometimes' }, 'git commit -m "x"', false],
    ['a commit spelled out in a wrapper', {}, 'bash -c \'git commit -m x\'', true],
    ['a wrapped command that never commits', {}, 'bash -c \'ls\'', false],
    ['a wrapper on text built at run time', {}, 'bash -c "$CMD"', true],
  ])('applies: %s', (_shape, fields, command, expected) => {
    expect(JUDGMENT.applies?.({ question: QUESTION, ...fields }, command, scratch()))
      .toBe(expected);
  });

  // A wrapped command whose text is spelled out is the same command with quotes
  // round it. Refusing to read it would put an UNCHECKED notice on every
  // wrapped call an agent makes, including the ones that never commit.
  test.each([
    ['bash -c', 'bash -c \'git commit -m "wrapped"\''],
    ['sh -c', 'sh -c \'git commit -m "wrapped"\''],
    ['eval', 'eval "git commit -m wrapped"'],
    ['a login shell', 'bash -lc \'git commit -m "wrapped"\''],
  ])('a commit spelled out inside %s is judged like any other', async (_shape, command) => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, { command, url: stub.url });

    expect(outcome.verdict).toBe('fires');
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]?.body.state.message).toBe('wrapped');
  });

  test('a wrapped command that never commits says nothing and reads nothing', async () => {
    const stub = provider({ noul: 0.99 });
    const git = recordingGit();
    const outcome = await evaluate({}, {
      command: 'bash -c \'ls -la\'',
      cwd: scratch(),
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}`, TYPESAFE_API_KEY: undefined },
    });

    expect(outcome.verdict).toBe('passes');
    expect(git.asked()).toBe(false);
    expect(stub.sent).toHaveLength(0);
  });

  // A shell handed a file is not a wrapper this can read into, but neither does
  // it hide a commit standing next to it: it is passed over, not reported on.
  test('a merge-request rule reads a wrapped forge command too', async () => {
    const asked = provider({ noul: 0.99 });
    const fired = await evaluate({ on: 'merge-request' }, {
      command: 'bash -c \'gh pr create --fill\'',
      url: asked.url,
    });

    expect(fired.verdict).toBe('fires');
    expect(asked.sent).toHaveLength(1);

    const quiet = provider({ noul: 0.99 });
    const outcome = await evaluate({ on: 'merge-request' }, {
      command: 'bash -c \'ls\'',
      url: quiet.url,
    });

    expect(outcome.verdict).toBe('passes');
    expect(quiet.sent).toHaveLength(0);
  });

  test('a shell running a script file hides nothing and is not reported', async () => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, {
      command: 'bash deploy.sh && git commit -m "after the script"',
      url: stub.url,
    });

    expect(outcome.verdict).toBe('fires');
    expect(stub.sent[0]?.body.state.message).toBe('after the script');
  });

  test('a shell running a script file on its own is silent', async () => {
    const stub = provider({ noul: 0.99 });
    const git = recordingGit();
    const outcome = await evaluate({}, {
      command: 'bash deploy.sh',
      cwd: scratch(),
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}`, TYPESAFE_API_KEY: undefined },
    });

    expect(outcome.verdict).toBe('passes');
    expect(git.asked()).toBe(false);
    expect(stub.sent).toHaveLength(0);
  });

  // A wrapper is a scope. Its cd moves the tree the wrapper's own commands see
  // and nothing else, so a commit standing after the wrapper is in the tree the
  // shell was in before it.
  test.each([
    ['a cd that stays inside its wrapper', 'outer', 'bash -c \'cd inner\' && git commit -m "x"'],
    ['a cd and a commit sharing one wrapper', 'inner', 'bash -c \'cd inner && git commit -m "x"\''],
    ['an outer cd the wrapper starts in', 'inner', 'cd inner && bash -c \'git commit -m "x"\''],
    ['a cd that stays inside its subshell', 'outer', '(cd inner) && git commit -m "x"'],
    ['a cd and a commit sharing one subshell', 'inner', '(cd inner && git commit -m "x")'],
  ])('%s reads the %s repository', async (_shape, which, command) => {
    const root = repo({ marker: 'the outer repository' });
    const inner = join(root, 'inner');
    mkdirSync(inner, { recursive: true });
    git(inner, 'init', '-q', '-b', 'main');
    writeFileSync(join(inner, 'a.ts'), 'export const a = 1; // the inner repository\n');
    git(inner, 'add', '-A');
    const stub = provider({ noul: 0.1 });
    await evaluate({}, { command, cwd: root, url: stub.url });
    const state = stub.sent[0]?.body.state as Record<string, string>;

    expect(state.diff).toContain(`the ${which} repository`);
  });

  // A cd this cannot read blocks whatever follows it, and a wrapper is not a
  // way past that: the commit inside one runs in whatever tree the cd reached.
  test.each([
    ['a variable', 'cd "$T" && bash -c \'git commit -m "x"\''],
    ['a glob', 'cd build-* && bash -c \'git commit -m "x"\''],
    ['a home-relative path', 'cd ~/proj && bash -c \'git commit -m "x"\''],
    ['an end-of-options marker', 'cd -- inner && bash -c \'git commit -m "x"\''],
    ['a variable, before a subshell', 'cd "$T" && (git commit -m "x")'],
    ['a glob, before a subshell', 'cd build-* && (git commit -m "x")'],
  ])('a cd naming %s blocks a commit in any scope after it', async (_shape, command) => {
    const stub = provider({ noul: 0.99 });
    const git = recordingGit();
    const outcome = await evaluate({}, {
      command,
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}` },
    });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' ? outcome.detail : '').toContain('changes directory');
    expect(git.asked()).toBe(false);
    expect(stub.sent).toHaveLength(0);
  });

  // The shell idiom for an apostrophe inside a single-quoted run: close, quote
  // the quote, reopen. The tokeniser reads one pair and stops, so the text it
  // hands back is not the command that would run.
  test('a wrapper whose quoting is concatenated is UNCHECKED, not mangled', async () => {
    const stub = provider({ noul: 0.99 });
    const outcome = await evaluate({}, {
      command: `bash -c 'git commit -m "it'"'"'s fine"'`,
      url: stub.url,
    });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' ? outcome.detail : '').toContain('quot');
    expect(stub.sent).toHaveLength(0);
  });

  test('an apostrophe in an ordinary commit message is judged, not refused', async () => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, {
      command: `git commit -m "it's fine"`,
      url: stub.url,
    });

    expect(outcome.verdict).toBe('fires');
    expect(stub.sent[0]?.body.state.message).toBe("it's fine");
  });

  // A wrapper word inside a message is a word, not a command. Only one in
  // command position makes the command's quoting worth refusing over.
  test('a message that merely mentions a shell is judged normally', async () => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, {
      command: 'git commit -m "run bash \\"now\\""',
      url: stub.url,
    });

    expect(outcome.verdict).toBe('fires');
    expect(stub.sent).toHaveLength(1);
  });

  // Not the first word of anything, so nothing here runs a shell: the quoting
  // gate has no whole command to be hiding and must stay out of the way.
  test('a shell named as an argument is not a wrapper', async () => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, {
      command: 'grep bash notes.txt && git commit -m "say \\"hi\\""',
      url: stub.url,
    });

    expect(outcome.verdict).toBe('fires');
    expect(stub.sent).toHaveLength(1);
  });

  test('a wrapped commit carries its own cd into the reading', async () => {
    const root = repo({ marker: 'the outer repository' });
    const inner = join(root, 'inner');
    mkdirSync(inner, { recursive: true });
    git(inner, 'init', '-q', '-b', 'main');
    writeFileSync(join(inner, 'a.ts'), 'export const a = 1; // the inner repository\n');
    git(inner, 'add', '-A');
    const stub = provider({ noul: 0.1 });
    await evaluate({}, {
      command: 'bash -c \'cd inner && git commit -m "in there"\'',
      cwd: root,
      url: stub.url,
    });
    const state = stub.sent[0]?.body.state as Record<string, string>;

    expect(state.diff).toContain('the inner repository');
  });

  test('a commit inside a subshell is still judged', async () => {
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, {
      command: '(git commit -m "in a subshell")',
      url: stub.url,
    });

    expect(outcome.verdict).toBe('fires');
    expect(stub.sent[0]?.body.state.message).toBe('in a subshell');
  });
});

describe('it never refuses on its own uncertainty', () => {
  test('a rule with no question is skipped, and git is never run', async () => {
    const stub = provider({ noul: 0.99 });
    const request: KindRequest = {
      command: 'git commit -m "anything"',
      cwd: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_BASE_URL: stub.url, TYPESAFE_API_KEY: 'sk-test' },
      match: refuseToMatch as KindRequest['match'],
      body: POLICY,
    };
    const outcome = await JUDGMENT.evaluate({}, request);

    expect(outcome.verdict).toBe('skipped');
    expect(outcome.verdict === 'skipped' ? outcome.detail : '').toContain('rule.question');
    expect(stub.sent).toHaveLength(0);
  });

  test('no key is UNCHECKED, and nothing is sent', async () => {
    const stub = provider({ noul: 0.99 });
    const outcome = await evaluate({}, {
      url: stub.url,
      env: { TYPESAFE_API_KEY: undefined },
    });
    const detail = outcome.verdict === 'unchecked' ? outcome.detail : '';

    expect(outcome.verdict).toBe('unchecked');
    expect(detail).toContain('TYPESAFE_API_KEY');
    expect(detail).toContain('typesafe-token');
    expect(stub.sent).toHaveLength(0);
  });

  test('a key written to the config file is read when the variable is unset', async () => {
    const home = scratch();
    mkdirSync(join(home, '.config', 'agentkit'), { recursive: true });
    writeFileSync(join(home, '.config', 'agentkit', 'typesafe-token'), 'sk-file\n');
    const stub = provider({ noul: 0.9 });
    const outcome = await evaluate({}, {
      url: stub.url,
      env: { TYPESAFE_API_KEY: undefined, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    });

    expect(outcome.verdict).toBe('fires');
    expect(stub.sent[0]?.authorization).toBe('Bearer sk-file');
  });

  test('a directory with no repository is UNCHECKED, not a silent pass', async () => {
    const stub = provider({ noul: 0.99 });
    const outcome = await evaluate({}, { cwd: scratch(), url: stub.url });
    const detail = outcome.verdict === 'unchecked' ? outcome.detail : '';

    expect(outcome.verdict).toBe('unchecked');
    expect(detail).toContain('git');
    expect(stub.sent).toHaveLength(0);
  });

  test.each([
    ['above one', 42],
    ['below zero', -3],
  ])('a probability %s is unusable, not a verdict', async (_shape, noul) => {
    const stub = provider({ noul });
    const outcome = await evaluate({}, { url: stub.url });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' ? outcome.detail : '').toContain('unusable');
  });

  test('an HTTP error is UNCHECKED and names the status', async () => {
    const stub = provider({ status: 500 });
    const outcome = await evaluate({}, { url: stub.url });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' ? outcome.detail : '').toContain('500');
  });

  test('a provider that never answers is UNCHECKED within the deadline', async () => {
    const stub = provider({ hang: true });
    const started = Date.now();
    const outcome = await evaluate({}, { url: stub.url, env: { TYPESAFE_TIMEOUT_MS: '300' } });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' ? outcome.detail : '').toContain('timeout');
    expect(Date.now() - started).toBeLessThan(9000);
  });
});

// The rule block is the only thing that varies, so the taste around it is the
// smallest one the lint accepts at enforce: block.
function blocking(rule: string): Record<string, string> {
  const front = [
    'name: no-stopgaps',
    'scope: project',
    'strength: require',
    'enforce: block',
    'provenance: 2026-09-21 · session correction',
    `rule:\n${rule}`,
  ].join('\n');
  return { 'no-stopgaps.md': `---\n${front}\n---\n\n${POLICY}\n` };
}

function lint(rule: string): string[] {
  const dir = scratch();
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(blocking(rule))) {
    writeFileSync(join(dir, name), contents);
  }
  return lintTasteDirectory(dir);
}

describe('the lint reads the judgment vocabulary', () => {
  test('a rule with a question, an occasion and a threshold is accepted', () => {
    expect(lint(
      `  kind: judgment\n  question: ${QUESTION}\n  on: commit\n  threshold: "0.75"\n`
        + '  remedy: Fix the cause, or say why the workaround is the fix.\n'
        + '  override: AGENTKIT_ALLOW_STOPGAP',
    )).toEqual([]);
  });

  test('a rule with only its question is accepted', () => {
    expect(lint(`  kind: judgment\n  question: ${QUESTION}\n  remedy: Fix the cause.`))
      .toEqual([]);
  });

  test('a question over the cap is refused', () => {
    const errors = lint(
      `  kind: judgment\n  question: ${'a'.repeat(600)}\n  remedy: Fix the cause.`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.question');
    expect(errors[0]).toContain('500');
  });

  test('a question carrying a command substitution is refused', () => {
    const errors = lint(
      '  kind: judgment\n  question: "Does this break $(git config user.name)?"\n'
        + '  remedy: Fix the cause.',
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.question');
  });

  test('an occasion that is not one of the three is refused', () => {
    const errors = lint(
      `  kind: judgment\n  question: ${QUESTION}\n  on: sometimes\n  remedy: Fix the cause.`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.on');
    expect(errors[0]).toContain('merge-request');
  });

  test('a threshold that is not a number is refused', () => {
    const errors = lint(
      `  kind: judgment\n  question: ${QUESTION}\n  threshold: high\n  remedy: Fix the cause.`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.threshold');
  });

  test.each([
    ['an unquoted number above the range', 'threshold: 2'],
    ['an unquoted negative', 'threshold: -1'],
    ['an unquoted fraction above the range', 'threshold: 1.5'],
    ['a hexadecimal that Number would accept', 'threshold: "0x1"'],
    ['a float in exponent form', 'threshold: "1e-1"'],
  ])('a threshold written as %s is refused', (_shape, line) => {
    const errors = lint(`  kind: judgment\n  question: ${QUESTION}\n  ${line}\n  remedy: Fix it.`);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.threshold');
  });

  test('an occasion written as an unquoted number is refused', () => {
    const errors = lint(`  kind: judgment\n  question: ${QUESTION}\n  on: 2\n  remedy: Fix it.`);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.on');
  });

  // Refused either way it arrives: as the string "yes" the enum does not carry,
  // or, from a YAML 1.1 parser, as a boolean no rule value may be.
  test('an occasion written as a YAML boolean is refused', () => {
    const errors = lint(`  kind: judgment\n  question: ${QUESTION}\n  on: yes\n  remedy: Fix it.`);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.on');
  });

  test('a threshold at either end of the range is accepted', () => {
    for (const value of ['0', '1', '0.75']) {
      expect(lint(
        `  kind: judgment\n  question: ${QUESTION}\n  threshold: "${value}"\n  remedy: Fix it.`,
      )).toEqual([]);
    }
  });

  test('a threshold outside 0 to 1 is refused', () => {
    const errors = lint(
      `  kind: judgment\n  question: ${QUESTION}\n  threshold: "1.5"\n  remedy: Fix the cause.`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.threshold');
  });

  test('a rule with no question is refused', () => {
    const errors = lint('  kind: judgment\n  remedy: Fix the cause.');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.question');
  });

  // Bun 1.3.4 reads a bare `on` key as the boolean true and 1.3.10 does not, so
  // the same file arrives with either key depending on which runtime read it.
  test('an occasion the parser read as a boolean is still the on its author typed', () => {
    expect(ruleFields({ kind: 'judgment', true: 'merge-request' }))
      .toEqual({ kind: 'judgment', on: 'merge-request' });
    expect(ruleFields({ kind: 'judgment', on: 'merge-request' }))
      .toEqual({ kind: 'judgment', on: 'merge-request' });
  });

  test('a rule carrying both spellings of the key is an error, not last-wins', () => {
    const errors = onKeyErrors({ kind: 'judgment', on: 'commit', true: 'merge-request' });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('both on and true');
    expect(onKeyErrors({ kind: 'judgment', on: 'commit' })).toEqual([]);
    expect(onKeyErrors({ kind: 'judgment', true: 'commit' })).toEqual([]);
  });

  test('a rule value that is a list rather than one value is refused by name', () => {
    const errors = lint(
      `  kind: judgment\n  question: ${QUESTION}\n  on:\n    - commit\n  remedy: Fix it.`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.on');
    expect(errors[0]).toContain('not a single value');
  });

  // Written as the boolean key a YAML 1.1 parser produces for `on`, so the
  // resolver's own normalisation is exercised whichever parser reads the file.
  test('the resolver hands a kind the occasion, whichever key the parser made', () => {
    const dir = scratch();
    mkdirSync(join(dir, '.agentkit', 'tastes'), { recursive: true });
    const front = [
      'name: no-stopgaps',
      'scope: project',
      'strength: require',
      'enforce: block',
      'provenance: 2026-09-21 · session correction',
      'rule:',
      '  kind: judgment',
      `  question: ${QUESTION}`,
      '  true: merge-request',
      '  remedy: Fix the cause.',
    ].join('\n');
    writeFileSync(
      join(dir, '.agentkit', 'tastes', 'no-stopgaps.md'),
      `---\n${front}\n---\n\n${POLICY}\n`,
    );
    const { tastes, warnings } = resolveTastes(dir, scratch(), {});

    expect(warnings).toEqual([]);
    expect(tastes[0]?.rule?.fields.on).toBe('merge-request');
    expect(tastes[0]?.rule?.fields.true).toBeUndefined();
  });

  test('a key belonging to another kind is unknown here', () => {
    const errors = lint(
      `  kind: judgment\n  question: ${QUESTION}\n  policy: no-duplicate\n  remedy: Fix it.`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown rule key: policy');
  });
});


// A taste folder the lint accepts, so the whole hook lane runs over it rather
// than the kind alone. Names decide the order tastes are evaluated in, which is
// what lets a later taste prove it still enforces after an earlier one stalled.
function blockingTaste(name: string, rule: Record<string, string>): string {
  const lines = [
    `name: ${name}`,
    'scope: project',
    'strength: require',
    'enforce: block',
    'provenance: 2026-09-21 · session correction',
    'rule:',
    ...Object.entries(rule).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
  ];
  return `---\n${lines.join('\n')}\n---\n\n${POLICY}\n`;
}

function project(tastes: Record<string, Record<string, string>>): string {
  const dir = repo();
  mkdirSync(join(dir, '.agentkit', 'tastes'), { recursive: true });
  for (const [name, rule] of Object.entries(tastes)) {
    writeFileSync(join(dir, '.agentkit', 'tastes', `${name}.md`), blockingTaste(name, rule));
  }
  return dir;
}

const JUDGE = (name: string) => ({
  kind: 'judgment',
  question: QUESTION,
  remedy: `Fix the cause (${name}).`,
  override: 'AGENTKIT_ALLOW_STOPGAP',
});

describe('one budget for every judgment in a command', () => {
  // The hook runs the evaluator under a process cap and reads nothing when it
  // is killed, so every blocking taste goes unenforced. The budget has to bound
  // the whole run, not each call.
  test('two stalled judgments still leave a command taste enforcing', async () => {
    const stub = provider({ hang: true });
    const cwd = project({
      'aa-stalls': JUDGE('aa'),
      'ab-stalls': JUDGE('ab'),
      'zz-tag-tier': {
        kind: 'command',
        match: 'git commit',
        remedy: 'Say what the commit does.',
        override: 'AGENTKIT_TAG_TIER',
      },
    });
    const started = Date.now();
    const verdict = await evaluateCommand({
      command: 'git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });
    const elapsed = Date.now() - started;

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('Say what the commit does.');
    expect(verdict.notices.filter((notice) => notice.includes('UNCHECKED'))).toHaveLength(2);
    expect(elapsed).toBeLessThan(JUDGMENT_BUDGET_MS + 2500);
  }, 20000);

  // The aggregate budget clamps every grant, so a per-call cap above it would
  // change nothing and go unnoticed. One stalled taste pins it.
  test('one stalled judgment gives up at the per-call cap, not at the budget', async () => {
    const stub = provider({ hang: true });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const started = Date.now();
    const verdict = await evaluateCommand({
      command: 'git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });
    const elapsed = Date.now() - started;

    expect(JUDGMENT_CALL_MS).toBeLessThan(JUDGMENT_BUDGET_MS);
    expect(verdict.notices.join(' ')).toContain(`timeout after ${JUDGMENT_CALL_MS}ms`);
    expect(elapsed).toBeLessThan(JUDGMENT_CALL_MS + 1200);
  }, 20000);

  test('a judgment reached after the budget is spent says so', async () => {
    const stub = provider({ hang: true });
    const cwd = project({
      'aa-stalls': JUDGE('aa'),
      'ab-stalls': JUDGE('ab'),
      'ac-stalls': JUDGE('ac'),
    });
    const verdict = await evaluateCommand({
      command: 'git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join(' ')).toContain('judgment budget for this command is spent');
    expect(stub.sent.length).toBeLessThan(3);
  }, 20000);
});

describe('a deliberate override is read before the check it overrules', () => {
  test('an override set on the command sends nothing to the provider', async () => {
    const stub = provider({ noul: 0.99 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'AGENTKIT_ALLOW_STOPGAP=1 git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join(' ')).toContain('set deliberately');
    expect(stub.sent).toHaveLength(0);
  });

  test('an override exported into the session does the same', async () => {
    const stub = provider({ noul: 0.99 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: {
        PATH: process.env.PATH,
        TYPESAFE_API_KEY: 'sk-test',
        TYPESAFE_BASE_URL: stub.url,
        AGENTKIT_ALLOW_STOPGAP: '1',
      },
    });

    expect(verdict.decision).toBe('allow');
    expect(stub.sent).toHaveLength(0);
  });

  // The short-circuit must not turn an exported override into a notice on
  // every command the session runs.
  test('an exported override says nothing about a command the rule never judges', async () => {
    const stub = provider({ noul: 0.99 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'git status --short',
      cwd,
      home: scratch(),
      env: {
        PATH: process.env.PATH,
        TYPESAFE_API_KEY: 'sk-test',
        TYPESAFE_BASE_URL: stub.url,
        AGENTKIT_ALLOW_STOPGAP: '1',
      },
    });

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
    expect(stub.sent).toHaveLength(0);
  });

  test('an override that does not read as deliberate still pays for the check', async () => {
    const stub = provider({ noul: 0.99 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'AGENTKIT_ALLOW_STOPGAP=0 git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });

    expect(verdict.decision).toBe('deny');
    expect(stub.sent).toHaveLength(1);
  });
});
