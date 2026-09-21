import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCommand, tasteLanes } from '../../skills/taste/scripts/police.ts';
import { actedDirectories, scopedCommand } from '../../skills/taste/scripts/rules/scope.ts';

const servers: { stop(force?: boolean): void }[] = [];

const sandboxes: string[] = [];

afterEach(() => {
  while (servers.length > 0) (servers.pop() as { stop(force?: boolean): void }).stop(true);
  while (sandboxes.length > 0) rmSync(sandboxes.pop() as string, { recursive: true, force: true });
});

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
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

// A repository with one staged line that names itself, so a diff that reaches
// the provider says which repository it came from.
function repository(parent: string, name: string, marker = name): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  writeFileSync(join(dir, 'a.ts'), `export const a = 1; // SECRET_FROM_${marker}\n`);
  git(dir, 'add', '-A');
  return dir;
}

function judgmentTaste(dir: string, name: string, question: string, override: string): void {
  const front = [
    `name: ${name}`,
    'scope: project',
    'strength: require',
    'enforce: block',
    'provenance: 2026-09-21 · session correction',
    'rule:',
    '  kind: judgment',
    `  question: ${question}`,
    `  remedy: Fix it the ${name} way.`,
    `  override: ${override}`,
  ].join('\n');
  mkdirSync(join(dir, '.agentkit', 'tastes'), { recursive: true });
  writeFileSync(
    join(dir, '.agentkit', 'tastes', `${name}.md`),
    `---\n${front}\n---\n\nThe ${name} preference.\n\nWhy: it holds.\n\n`
      + 'How to apply: read it first.\n',
  );
}

interface Asked {
  command: string;
  diff: string;
  message: string;
  policy: string;
}

function stubProvider(noul: number): { url: string; asked: Asked[] } {
  const asked: Asked[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request) {
      const body = await request.json() as {
        state: Record<string, string>;
        questions: { q: { instructions: Record<string, string> } };
      };
      asked.push({
        command: body.state.command as string,
        diff: body.state.diff as string,
        message: body.state.message as string,
        policy: body.questions.q.instructions.policy as string,
      });
      return Response.json({ model: 'jev-1', answers: { q: { type: 'noul', noul } } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, asked };
}

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-target-'));
  sandboxes.push(root);
  return root;
}

function taste(name: string, match: string): string {
  const front = [
    `name: ${name}`,
    'scope: project',
    'strength: require',
    'enforce: block',
    'provenance: 2026-09-21 · session correction',
    'rule:',
    '  kind: command',
    `  match: ${JSON.stringify(match)}`,
    `  remedy: Do it the ${name} way.`,
    `  override: AGENTKIT_${name.toUpperCase().replace(/-/g, '_')}`,
  ].join('\n');
  const body = `The ${name} preference.\n\nWhy: it holds next time.\n\n`
    + 'How to apply: read it before acting.';
  return `---\n${front}\n---\n\n${body}\n`;
}

// A repository holding its own tastes, under a parent that has none.
function repoIn(parent: string, name: string, rule: { taste: string; match: string }): string {
  const dir = repository(parent, name);
  mkdirSync(join(dir, '.agentkit', 'tastes'), { recursive: true });
  writeFileSync(
    join(dir, '.agentkit', 'tastes', `${rule.taste}.md`),
    taste(rule.taste, rule.match),
  );
  return dir;
}

function userTaste(home: string, name: string, match: string): string {
  mkdirSync(join(home, '.agentkit', 'tastes'), { recursive: true });
  writeFileSync(join(home, '.agentkit', 'tastes', `${name}.md`), taste(name, match));
  return home;
}

function evaluate(command: string, cwd: string, env: Record<string, string> = {}) {
  const request = { command, cwd, home: scratch(), env: { PATH: process.env.PATH, ...env } };
  return evaluateCommand(request);
}

describe('which directories a command acts in', () => {
  test('a command that never leaves the directory it started in names none', () => {
    const cwd = scratch();

    expect(actedDirectories('git tag v0.8.0', cwd).dirs).toEqual([]);
    expect(actedDirectories('git tag v0.8.0', cwd).atStart).toBe(true);
    expect(actedDirectories('ls -la && echo hi', cwd).dirs).toEqual([]);
  });

  test.each([
    ['a literal cd', 'cd repo && git tag v0.8.0', ['repo']],
    ['git -C', 'git -C repo tag v0.8.0', ['repo']],
    ['a cd inside a wrapper', 'bash -c \'cd repo && git tag v0.8.0\'', ['repo']],
    ['a cd inside a subshell', '(cd repo && git tag v0.8.0)', ['repo']],
    ['two repositories', 'cd a && git tag v1.0.0 && cd ../b && git push', ['a', 'b']],
    ['the same repository twice', 'cd repo && git add . && git tag v1.0.0', ['repo']],
  ])('%s names %s', (_shape, command, expected) => {
    const cwd = scratch();

    expect(actedDirectories(command, cwd).dirs).toEqual(expected.map((name) => join(cwd, name)));
  });

  test('a subshell that only changes directory names nothing', () => {
    const cwd = scratch();

    expect(actedDirectories('(cd repo) && git tag v0.8.0', cwd).dirs).toEqual([]);
  });

  // The notice exists to say a repository's tastes went unloaded, and only a
  // command that reaches a forge or a repository could have had any.
  test('a directory change this cannot read is named when git follows it', () => {
    const cwd = scratch();
    const found = actedDirectories('cd "$T" && git tag v0.8.0', cwd);

    expect(found.dirs).toEqual([]);
    expect(found.unread).toContain('changes directory');
  });

  test('the same change is passed over when nothing repository-shaped follows', () => {
    const cwd = scratch();

    expect(actedDirectories('cd "$T" && ls -la', cwd).unread).toBeUndefined();
  });
});

describe('the tastes that apply are the targeted repository\'s', () => {
  test('a command reaching a repository by cd is judged by its tastes', async () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'tag .*v[0-9]+\\.[0-9]+\\.0' });
    const verdict = await evaluate('cd repo && git tag v0.8.0', parent);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('release-tier');
    expect(verdict.reason).toContain('Do it the release-tier way.');
  });

  // macOS reaches its temporary directory through a symlink, so the followed
  // path and the one the command names are different strings for one place.
  // Everything here compares followed paths; a link in the way proves it.
  test('a session reached through a symlink is judged the same way', async () => {
    const real = scratch();
    repoIn(real, 'repo', { taste: 'release-tier', match: 'tag .*v[0-9]+\\.[0-9]+\\.0' });
    const linked = join(scratch(), 'parent');
    symlinkSync(real, linked, 'dir');
    const verdict = await evaluate('cd repo && git tag v0.8.0', linked);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('release-tier');
  });

  test('a command reaching it by git -C is judged the same way', async () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'tag .*v[0-9]+\\.[0-9]+\\.0' });
    const verdict = await evaluate('git -C repo tag v0.8.0', parent);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('release-tier');
  });

  test('the session sitting in the repository still works as it did', async () => {
    const parent = scratch();
    const repo = repoIn(parent, 'repo', {
      taste: 'release-tier',
      match: 'tag .*v[0-9]+\\.[0-9]+\\.0',
    });
    const verdict = await evaluate('git tag v0.8.0', repo);

    expect(verdict.decision).toBe('deny');
  });

  test('two repositories in one command each bring their own', async () => {
    const parent = scratch();
    repoIn(parent, 'a', { taste: 'release-tier', match: 'git tag' });
    repoIn(parent, 'b', { taste: 'force-push', match: 'git push --force' });

    const first = await evaluate('cd a && git tag v0.8.0', parent);
    expect(first.reason).toContain('release-tier');

    const second = await evaluate('cd b && git push --force', parent);
    expect(second.reason).toContain('force-push');
  });

  test('a repository with no tastes of its own adds nothing and says nothing', async () => {
    const parent = scratch();
    repository(parent, 'other');
    const verdict = await evaluate('cd other && git status', parent);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
  });

  test('the taste of a directory the command never enters stays out of it', async () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'git tag' });
    repository(parent, 'other');
    const verdict = await evaluate('cd other && git tag v0.8.0', parent);

    expect(verdict.decision).toBe('allow');
  });
});

describe('a directory this cannot name', () => {
  test('is reported once, and the command is allowed', async () => {
    const parent = scratch();
    const verdict = await evaluate('cd "$TARGET" && git tag v0.8.0', parent);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toHaveLength(1);
    expect(verdict.notices[0]).toContain('UNCHECKED');
    expect(verdict.notices[0]).toContain('project tastes');
  });

  test('is passed over when the command reaches no repository after it', async () => {
    const parent = scratch();
    const verdict = await evaluate('cd "$TARGET" && ls -la', parent);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
  });
});

describe('the cheap path stays cheap', () => {
  // Every extra lane is a directory tree walked on every command an agent runs,
  // so a command that never leaves its directory must resolve exactly one.
  test('a command that changes no directory resolves one taste folder', () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'git tag' });
    const { lanes } = tasteLanes('git tag v0.8.0', parent, scratch(), {});

    expect(lanes.map((lane) => lane.cwd)).toEqual([parent]);
  });

  // The owner's own tastes bind wherever they are working, so they belong to
  // the session's lane and nowhere else. Loaded again per directory they would
  // be judged, and reported on, once per repository the command touches.
  test('a repository lane carries that repository\'s tastes and nothing else', () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'git tag' });
    const home = userTaste(scratch(), 'commit-identity', 'git commit');
    const { lanes } = tasteLanes('cd repo && git tag v0.8.0', parent, home, {});

    expect(lanes[0]?.tastes.map((one) => one.name)).toEqual(['commit-identity']);
    expect(lanes[1]?.tastes.map((one) => one.name)).toEqual(['release-tier']);
    expect(lanes[1]?.tastes.map((one) => one.layer)).toEqual(['project']);
  });

  test('a user taste is answered once, however many repositories are reached', async () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'git push --force' });
    const home = userTaste(scratch(), 'commit-identity', 'git tag');
    const verdict = await evaluateCommand({
      command: 'AGENTKIT_COMMIT_IDENTITY=1 cd repo && git tag v0.8.0',
      cwd: parent,
      home,
      env: { PATH: process.env.PATH },
    });

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toHaveLength(1);
    expect(verdict.notices[0]).toContain('commit-identity');
  });

  test('a command that enters one resolves two, and no more', () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'git tag' });
    repository(parent, 'other');
    const { lanes } = tasteLanes('cd repo && git tag v0.8.0', parent, scratch(), {});

    // The lane is the followed path, which on a machine whose temporary
    // directory is a link is not the one the command spells.
    expect(lanes.map((lane) => lane.cwd)).toEqual([parent, realpathSync(join(parent, 'repo'))]);
  });
});


describe('a kind that reads a directory reads the targeted repository\'s', () => {
  const SHAPES: [string, (repo: string, name: string) => string][] = [
    ['cd', (_repo, name) => `cd ${name} && git commit -m "x"`],
    ['git -C', (_repo, name) => `git -C ${name} commit -m "x"`],
    ['a subshell', (_repo, name) => `(cd ${name} && git commit -m "x")`],
    ['a wrapper', (_repo, name) => `bash -c 'cd ${name} && git commit -m "x"'`],
    ['an absolute cd', (repo) => `cd ${repo} && git commit -m "x"`],
  ];

  test.each(SHAPES)('a judgment taste is reached through %s', async (_shape, shape) => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    judgmentTaste(repo, 'no-stopgaps', 'Is this a stopgap?', 'AGENTKIT_NO_STOPGAPS');
    const stub = stubProvider(0.9);
    const verdict = await evaluateCommand({
      command: shape(repo, 'repoA'),
      cwd: parent,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'k', TYPESAFE_BASE_URL: stub.url },
    });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('no-stopgaps');
    expect(stub.asked).toHaveLength(1);
    expect(stub.asked[0]?.diff).toContain('SECRET_FROM_repoA');
  });
});

describe('a taste sees only the part of the command acting in its repository', () => {
  test('a pattern is tested against that repository\'s segments alone', async () => {
    const parent = scratch();
    repository(parent, 'repoA');
    const repoB = repository(parent, 'repoB');
    mkdirSync(join(repoB, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repoB, '.agentkit', 'tastes', 'no-bbb.md'), taste('no-bbb', 'BBB'));
    const verdict = await evaluate(
      'cd repoA && git commit -m BBB && cd ../repoB && git status',
      parent,
    );

    expect(verdict.decision).toBe('allow');
  });

  test('a judgment never receives another repository\'s diff', async () => {
    const parent = scratch();
    const repoA = repository(parent, 'repoA');
    const repoB = repository(parent, 'repoB');
    judgmentTaste(repoB, 'bee', 'Is this a stopgap?', 'AGENTKIT_BEE');
    const stub = stubProvider(0.1);
    await evaluateCommand({
      command: `cd ${repoA} && git commit -m "in A" && cd ${repoB} && git commit -m "in B"`,
      cwd: parent,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'k', TYPESAFE_BASE_URL: stub.url },
    });

    for (const one of stub.asked) {
      expect(one.diff).not.toContain('SECRET_FROM_repoA');
      expect(one.command).not.toContain('in A');
    }
    expect(stub.asked.map((one) => one.message)).toEqual(['in B']);
  });
});

describe('a session inside a repository reads that repository\'s tastes', () => {
  function withTaste(parent: string, name: string): string {
    const repo = repository(parent, name);
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'no-tag.md'), taste('no-tag', 'git tag'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    return repo;
  }

  // The tastes that bind are the same whether the session stands at the top of
  // the checkout, inside it, or above it and reaches in.
  test('a session in a subdirectory is bound by the tastes at the top', async () => {
    const repo = withTaste(scratch(), 'repoA');

    expect((await evaluate('git tag v0.8.0', join(repo, 'src'))).decision).toBe('deny');
  });

  test('and it is the same answer the parent gets reaching in', async () => {
    const parent = scratch();
    withTaste(parent, 'repoA');

    expect((await evaluate('cd repoA/src && git tag v0.8.0', parent)).decision).toBe('deny');
  });

  test('a subdirectory reached through a symlink is bound the same way', async () => {
    const repo = withTaste(scratch(), 'repoA');
    const linked = join(scratch(), 'inside');
    symlinkSync(join(repo, 'src'), linked, 'dir');

    expect((await evaluate('git tag v0.8.0', linked)).decision).toBe('deny');
  });

  // The lane resolves its tastes at the top and still hands a kind the
  // directory the agent stands in, because a relative path in the command is
  // relative to that and to nothing else.
  test('a relative path in the command is read from where the agent stands', async () => {
    const parent = scratch();
    const repo = withTaste(parent, 'repoA');
    judgmentTaste(repo, 'no-stopgaps', 'Is this a stopgap?', 'AGENTKIT_NO_STOPGAPS');
    // The same relative name under both, so only the directory it is resolved
    // against decides which one answers.
    repository(join(repo, 'src'), 'sub', 'BESIDE_THE_AGENT');
    repository(repo, 'sub', 'AT_THE_TOP');
    const stub = stubProvider(0.1);
    await evaluateCommand({
      command: 'git -C sub commit -m "x"',
      cwd: join(repo, 'src'),
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'k', TYPESAFE_BASE_URL: stub.url },
    });

    expect(stub.asked).toHaveLength(1);
    expect(stub.asked[0]?.diff).toContain('SECRET_FROM_BESIDE_THE_AGENT');
  });

  test('a session in no checkout at all reads what it always did', async () => {
    const parent = scratch();
    mkdirSync(join(parent, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(parent, '.agentkit', 'tastes', 'no-tag.md'), taste('no-tag', 'git tag'));

    expect((await evaluate('git tag v0.8.0', parent)).decision).toBe('deny');
    expect((await evaluate('git status', parent)).decision).toBe('allow');
  });

  test('a checkout turning tastes off turns them off for a session inside it', async () => {
    const repo = withTaste(scratch(), 'repoA');
    writeFileSync(
      join(repo, '.agentkit', 'config.yaml'),
      'brain:\n  taste:\n    enabled: false\n',
    );

    expect((await evaluate('git tag v0.8.0', join(repo, 'src'))).decision).toBe('allow');
  });
});

describe('a repository taste shadows the user taste of the same name', () => {
  test('inside that repository, the repository wins', async () => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'shared.md'), taste('shared', 'YYY'));
    const home = userTaste(scratch(), 'shared', 'XXX');
    const verdict = await evaluateCommand({
      command: 'cd repoA && git commit -m XXX',
      cwd: parent,
      home,
      env: { PATH: process.env.PATH },
    });

    expect(verdict.decision).toBe('allow');
  });

  test('and the repository\'s own rule still binds there', async () => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'shared.md'), taste('shared', 'YYY'));
    const home = userTaste(scratch(), 'shared', 'XXX');
    const verdict = await evaluateCommand({
      command: 'cd repoA && git commit -m YYY',
      cwd: parent,
      home,
      env: { PATH: process.env.PATH },
    });

    expect(verdict.decision).toBe('deny');
  });
});

describe('only a repository brings tastes, and only where one is worked in', () => {
  // A dependency that is a checkout of its own is still a dependency. Its
  // remedy is prose an agent is shown verbatim, and nobody vouched for it.
  test.each([
    ['named outright', (planted: string) => `cd ${planted} && git status`],
    ['reached by ..', (planted: string) => `cd ${planted}/../evil && git status`],
  ])('a checkout planted under node_modules and %s is never read', async (_shape, shape) => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    const planted = join(repo, 'node_modules', 'evil');
    mkdirSync(join(planted, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(planted, '.agentkit', 'tastes', 'planted.md'), taste('planted', 'git'));
    git(planted, 'init', '-q', '-b', 'main');
    const verdict = await evaluate(shape(planted), parent);

    expect(verdict.decision).toBe('allow');
    expect(JSON.stringify(verdict)).not.toContain('planted');
  });

  test('a symlink out of a checkout is followed before it is judged', async () => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    const planted = join(repo, 'node_modules', 'evil');
    mkdirSync(join(planted, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(planted, '.agentkit', 'tastes', 'planted.md'), taste('planted', 'git'));
    git(planted, 'init', '-q', '-b', 'main');
    symlinkSync(planted, join(parent, 'innocent'), 'dir');
    const verdict = await evaluate('cd innocent && git status', parent);

    expect(verdict.decision).toBe('allow');
    expect(JSON.stringify(verdict)).not.toContain('planted');
  });

  test('a directory inside a repository brings the repository\'s tastes', async () => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'no-tag.md'), taste('no-tag', 'git tag'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    const verdict = await evaluate('cd repoA/src && git tag v1.0.0', parent);

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('no-tag');
  });

  test('a directory that is no repository brings nothing, taste folder or not', () => {
    const parent = scratch();
    const plain = join(parent, 'plain');
    mkdirSync(join(plain, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(plain, '.agentkit', 'tastes', 'planted.md'), taste('planted', 'git'));
    const { lanes } = tasteLanes('cd plain && git status', parent, scratch(), {});

    expect(lanes.map((lane) => lane.cwd)).toEqual([parent]);
  });

  test('a directory entered by something other than a repository command is passed over', () => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'no-rm.md'), taste('no-rm', 'rm -rf'));
    const { lanes } = tasteLanes('cd repoA && rm -rf build', parent, scratch(), {});

    expect(lanes.map((lane) => lane.cwd)).toEqual([parent]);
  });
});

describe('a repository turning tastes off turns off its own lane only', () => {
  test('its tastes stop binding', async () => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'no-tag.md'), taste('no-tag', 'git tag'));
    writeFileSync(
      join(repo, '.agentkit', 'config.yaml'),
      'brain:\n  taste:\n    enabled: false\n',
    );

    expect((await evaluate('cd repoA && git tag v1.0.0', parent)).decision).toBe('allow');
  });

  test('and the session\'s own tastes keep binding', async () => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    mkdirSync(join(repo, '.agentkit'), { recursive: true });
    writeFileSync(
      join(repo, '.agentkit', 'config.yaml'),
      'brain:\n  taste:\n    enabled: false\n',
    );
    mkdirSync(join(parent, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(parent, '.agentkit', 'tastes', 'no-tag.md'), taste('no-tag', 'git tag'));

    expect((await evaluate('cd repoA && git tag v1.0.0', parent)).decision).toBe('deny');
  });
});


describe('the same taste gives the same verdict wherever the session sits', () => {
  // A pattern is written against the command an agent types. Re-spelling the
  // text to scope it must not change what that pattern sees, or a taste means
  // one thing inside its repository and another from one directory up.
  const QUOTED: [string, string, string][] = [
    ['a single-quoted word', "-m 'wip'", 'git commit -m \'wip\''],
    ['a quote inside a message', 'say "hi"', 'git commit -m \'say "hi" now\''],
    ['a message with spaces', 'fix the thing', 'git commit -m "fix the thing"'],
    ['a flag and its value', '--no-verify', 'git commit --no-verify -m "x"'],
  ];

  test.each(QUOTED)('%s reads the same from every direction', async (_shape, match, command) => {
    const parent = scratch();
    const repo = repository(parent, 'repoA');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'shaped.md'), taste('shaped', match));

    const inside = await evaluate(command, repo);
    expect(inside.decision).toBe('deny');

    // A wrapper carries the command verbatim in whichever quote it does not
    // already use. One using both cannot be wrapped without the concatenation
    // idiom, which this deliberately refuses to read, so it is left out here
    // rather than tested for the wrong answer.
    const wrapper = command.includes('"')
      ? (command.includes("'") ? undefined : `bash -c 'cd repoA && ${command}'`)
      : `bash -c "cd repoA && ${command}"`;

    for (const reach of [
      `cd repoA && ${command}`,
      command.replace('git ', 'git -C repoA '),
      `(cd repoA && ${command})`,
      ...(wrapper === undefined ? [] : [wrapper]),
    ]) {
      expect((await evaluate(reach, parent)).decision, reach).toBe('deny');
    }
  });
});

describe('one repository\'s name does not speak for another', () => {
  // Both are checkouts with tastes of their own, so both raise a lane. Only
  // repoA names `shared`; repoB has a taste of its own that matches nothing.
  function pair(): { parent: string; home: string } {
    const parent = scratch();
    const repoA = repository(parent, 'repoA');
    const repoB = repository(parent, 'repoB');
    mkdirSync(join(repoA, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repoA, '.agentkit', 'tastes', 'shared.md'), taste('shared', 'YYY'));
    mkdirSync(join(repoB, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repoB, '.agentkit', 'tastes', 'other.md'), taste('other', 'QQQ'));
    return { parent, home: userTaste(scratch(), 'shared', 'ZZZ') };
  }

  test('the owner\'s taste still binds a repository that overrides nothing', async () => {
    const { parent, home } = pair();
    const alone = await evaluateCommand({
      command: 'cd repoB && git commit -m ZZZ',
      cwd: parent,
      home,
      env: { PATH: process.env.PATH },
    });

    expect(alone.decision).toBe('deny');
  });

  test('and an unrelated visit to the one that does override it changes nothing', async () => {
    const { parent, home } = pair();
    const beside = await evaluateCommand({
      command: 'cd repoA && git status && cd ../repoB && git commit -m ZZZ',
      cwd: parent,
      home,
      env: { PATH: process.env.PATH },
    });

    expect(beside.decision).toBe('deny');
  });
});

describe('a taste is not shown a command the agent never typed', () => {
  // Asserted on the text itself, because what a pattern is matched against is
  // the whole of what a taste of this kind can see.
  test.each([
    [
      'two visits with another repository between them',
      'cd repoA && git add . ; cd ../repoB && git status ; cd ../repoA && git push',
      'git add .\ngit push',
    ],
    [
      'two commands written next to each other',
      'cd repoA && git add . ; git commit -m x',
      'git add . ; git commit -m x',
    ],
    [
      'a command outside a wrapper and one inside it',
      "cd repoA && git add . && bash -c 'git commit -m x'",
      'git add .\ngit commit -m x',
    ],
    [
      'a pointer the caller is about to supply itself',
      'git -C repoA commit -m "keep the quotes"',
      'git commit -m "keep the quotes"',
    ],
  ])('%s reads as %s', (_shape, command, expected) => {
    // Reached through a link, because a machine whose temporary directory is
    // one — macOS is — hands these two sides different strings for one place.
    const real = scratch();
    repository(real, 'repoA');
    repository(real, 'repoB');
    const parent = join(scratch(), 'parent');
    symlinkSync(real, parent, 'dir');

    expect(scopedCommand(command, parent, { within: join(parent, 'repoA') })).toBe(expected);
  });

  test('two visits to one repository are not joined into one command', async () => {
    const parent = scratch();
    const repoA = repository(parent, 'repoA');
    repository(parent, 'repoB');
    mkdirSync(join(repoA, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(
      join(repoA, '.agentkit', 'tastes', 'joined.md'),
      // `.` does not cross a line break, so this matches only if the two
      // visits were run together into one command.
      taste('joined', 'git add \\..*git push'),
    );
    const command = 'cd repoA && git add . ; cd ../repoB && git status ; '
      + 'cd ../repoA && git push --force';

    expect((await evaluate(command, parent)).decision).toBe('allow');
  });

  test('and the separator between two adjacent ones is the one that was typed', async () => {
    const parent = scratch();
    const repoA = repository(parent, 'repoA');
    mkdirSync(join(repoA, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(
      join(repoA, '.agentkit', 'tastes', 'typed.md'),
      taste('typed', 'git add \\. ; git commit'),
    );

    const verdict = await evaluate('cd repoA && git add . ; git commit -m x', parent);

    expect(verdict.decision).toBe('deny');
  });

  test('but each visit is still read', async () => {
    const parent = scratch();
    const repoA = repository(parent, 'repoA');
    repository(parent, 'repoB');
    mkdirSync(join(repoA, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(
      join(repoA, '.agentkit', 'tastes', 'no-force.md'),
      taste('no-force', 'git push --force'),
    );
    const command = 'cd repoA && git add . ; cd ../repoB && git status ; '
      + 'cd ../repoA && git push --force';

    expect((await evaluate(command, parent)).decision).toBe('deny');
  });
});


describe('a command that takes its checkout apart', () => {
  function repoWithTaste(parent: string): string {
    const repo = repository(parent, 'repoA');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'no-aaa.md'), taste('no-aaa', 'AAA'));
    return repo;
  }

  // A work tree spelled out names the directory as surely as -C does, and the
  // commit really lands there.
  test('a literal work tree is followed, and its tastes bind', async () => {
    const parent = scratch();
    repoWithTaste(parent);
    const command = 'git --git-dir=repoA/.git --work-tree=repoA commit -m AAA';

    expect((await evaluate(command, parent)).decision).toBe('deny');
  });

  test.each([
    ['a git dir with no work tree beside it', 'git --git-dir=repoA/.git commit -m AAA'],
    ['a work tree the command does not spell out', 'git --work-tree="$T" commit -m AAA'],
  ])('%s is reported, not passed over', async (_shape, command) => {
    const parent = scratch();
    repoWithTaste(parent);
    const verdict = await evaluate(command, parent);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join(' ')).toContain('UNCHECKED');
    expect(verdict.notices.join(' ')).toContain('project tastes');
  });
});

describe('the owner\'s own folder is the user layer, whatever else it is', () => {
  // Dotfiles kept in git make the owner's own directory a checkout. Every
  // session beneath it would otherwise read the user layer as a project one,
  // which no repository taste could ever stand back from.
  test('a home that is itself a checkout does not make it a project one', async () => {
    const home = scratch();
    git(home, 'init', '-q', '-b', 'main');
    mkdirSync(join(home, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(home, '.agentkit', 'tastes', 'shared.md'), taste('shared', 'XXX'));
    const work = join(home, 'work');
    mkdirSync(work, { recursive: true });
    const repo = repository(work, 'repoA');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'shared.md'), taste('shared', 'YYY'));

    const verdict = await evaluateCommand({
      command: 'cd repoA && git commit -m XXX',
      cwd: work,
      home,
      env: { PATH: process.env.PATH },
    });

    expect(verdict.decision).toBe('allow');
  });

  test('and a checkout above a session that is not home still governs it', async () => {
    const parent = scratch();
    const umbrella = repository(parent, 'code');
    mkdirSync(join(umbrella, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(umbrella, '.agentkit', 'tastes', 'no-tag.md'), taste('no-tag', 'git tag'));
    const inside = join(umbrella, 'somewhere');
    mkdirSync(inside, { recursive: true });

    expect((await evaluate('git tag v1.0.0', inside)).decision).toBe('deny');
  });
});

describe('a refusal names the file the way its repository does', () => {
  test('the path is read against the top of the checkout, not the session', async () => {
    const parent = scratch();
    const repo = repository(parent, 'repoB');
    mkdirSync(join(repo, '.agentkit', 'tastes'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'tastes', 'no-bbb.md'), taste('no-bbb', 'BBB'));
    mkdirSync(join(repo, 'sub'), { recursive: true });

    for (const cwd of [repo, join(repo, 'sub')]) {
      const verdict = await evaluate('git commit -m BBB', cwd);

      expect(verdict.decision, cwd).toBe('deny');
      expect(verdict.reason, cwd).toContain('.agentkit/tastes/no-bbb.md');
      expect(verdict.reason, cwd).not.toContain(parent);
    }
  });
});
