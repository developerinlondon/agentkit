import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintTasteDirectory, ruleFields } from '../../skills/taste/scripts/lint.ts';
import { JUDGMENT } from '../../skills/taste/scripts/rules/judgment.ts';
import type { KindRequest, MatchOutcome } from '../../skills/taste/scripts/rules/kinds.ts';

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
function repo(options: { staged?: boolean } = {}): string {
  const dir = scratch();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'retry.ts'), 'export const retries = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  if (options.staged === false) return dir;
  writeFileSync(join(dir, 'retry.ts'), 'export const retries = 1; // stopgap until the fix\n');
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
      TYPESAFE_BASE_URL: options.url,
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

  test('a key belonging to another kind is unknown here', () => {
    const errors = lint(
      `  kind: judgment\n  question: ${QUESTION}\n  policy: no-duplicate\n  remedy: Fix it.`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown rule key: policy');
  });
});
