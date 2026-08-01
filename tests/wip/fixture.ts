import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const repoRoot = dirname(dirname(import.meta.dir));
export const toolTimeoutMs = 20_000;

export interface Sandbox {
  root: string;
  home: string;
  binDir: string;
}

/** A temporary HOME, so no tool under test reads the developer's real config. */
export function makeSandbox(prefix: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  return { root, home, binDir };
}

export function sandboxEnv(box: Sandbox, overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: box.home,
    XDG_CONFIG_HOME: join(box.home, '.config'),
    PATH: `${box.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    GIT_CONFIG_GLOBAL: join(box.home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...overrides,
  };
}

/**
 * A PATH holding only the named binaries. "gh is missing" is only an honest
 * probe when the runtime genuinely cannot find it — a shim that fails tests a
 * failing tool, which is a different assertion.
 */
export function restrictedPath(box: Sandbox, names: string[]): string {
  const dir = join(box.root, 'restricted-bin');
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (found.status !== 0) throw new Error(`fixture needs ${name} on PATH`);
    symlinkSync(found.stdout.trim(), join(dir, name));
  }
  return dir;
}

export function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

export function run(argv: string[], box: Sandbox, cwd: string, overrides: Record<string, string> = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    cwd,
    env: sandboxEnv(box, overrides),
    timeout: toolTimeoutMs,
  });
}

export function git(repo: string, box: Sandbox, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: sandboxEnv(box, {
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    }),
    timeout: toolTimeoutMs,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

export function commitFile(repo: string, box: Sandbox, name: string, body: string, message: string): void {
  const path = join(repo, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  git(repo, box, 'add', name);
  git(repo, box, 'commit', '-q', '-m', message);
}

/**
 * A clone whose default branch took a squashed copy of the branch's content.
 * This is the shape that makes an ancestry check lie: the squashed commit is
 * not an ancestor of the branch, so `rev-list origin/main..branch` still counts.
 */
export function makeSquashMergeRepo(box: Sandbox): string {
  const repo = join(box.root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, box, 'init', '-q', '-b', 'main');
  commitFile(repo, box, 'README.md', '# fixture\n', 'init');

  git(repo, box, 'checkout', '-q', '-b', 'feat/squashed');
  commitFile(repo, box, 'a.txt', 'one\n', 'a1');
  commitFile(repo, box, 'a.txt', 'one\ntwo\n', 'a2');

  git(repo, box, 'checkout', '-q', '-b', 'feat/unmerged', 'main');
  commitFile(repo, box, 'b.txt', 'b\n', 'b1');

  git(repo, box, 'checkout', '-q', 'main');
  git(repo, box, 'merge', '--squash', 'feat/squashed');
  git(repo, box, 'commit', '-q', '-m', 'squashed feat/squashed');

  // A remote whose refs a real clone would have. `origin/main` is what every
  // comparison in wip is made against.
  git(repo, box, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, box, 'remote', 'add', 'origin', 'https://forge.invalid/acme/fixture.git');
  return repo;
}
