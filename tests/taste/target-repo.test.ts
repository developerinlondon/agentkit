import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCommand, tasteLanes } from '../../skills/taste/scripts/police.ts';
import { actedDirectories } from '../../skills/taste/scripts/rules/scope.ts';

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) rmSync(sandboxes.pop() as string, { recursive: true, force: true });
});

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

// A directory holding a repository's own tastes, under a parent that has none.
function repoIn(parent: string, name: string, rule: { taste: string; match: string }): string {
  const dir = join(parent, name);
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

    expect(actedDirectories('git tag v0.8.0', cwd)).toEqual({ dirs: [] });
    expect(actedDirectories('ls -la && echo hi', cwd)).toEqual({ dirs: [] });
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

  test('a directory with no tastes of its own adds nothing and says nothing', async () => {
    const parent = scratch();
    mkdirSync(join(parent, 'other'), { recursive: true });
    const verdict = await evaluate('cd other && git status', parent);

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
  });

  test('the taste of a directory the command never enters stays out of it', async () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'git tag' });
    mkdirSync(join(parent, 'other'), { recursive: true });
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
    const lanes = tasteLanes('git tag v0.8.0', parent, scratch(), {});

    expect(lanes.map((lane) => lane.cwd)).toEqual([parent]);
  });

  // The owner's own tastes bind wherever they are working, so they belong to
  // the session's lane and nowhere else. Loaded again per directory they would
  // be judged, and reported on, once per repository the command touches.
  test('a repository lane carries that repository\'s tastes and nothing else', () => {
    const parent = scratch();
    repoIn(parent, 'repo', { taste: 'release-tier', match: 'git tag' });
    const home = userTaste(scratch(), 'commit-identity', 'git commit');
    const lanes = tasteLanes('cd repo && git tag v0.8.0', parent, home, {});

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
    mkdirSync(join(parent, 'other'), { recursive: true });
    const lanes = tasteLanes('cd repo && git tag v0.8.0', parent, scratch(), {});

    expect(lanes.map((lane) => lane.cwd)).toEqual([parent, join(parent, 'repo')]);
  });
});
