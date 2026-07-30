import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pkgPolice from '../plugins/pkg-police';

const repoRoot = dirname(import.meta.dir);
const hook = join(repoRoot, 'hooks', 'claude', 'pkg-police.sh');

// /tmp is inode-starved on the build host; /var/tmp is the working scratch.
const scratch = mkdtempSync('/var/tmp/pkg-police-test-');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Manager = 'bun' | 'npm' | 'pnpm' | 'yarn';

const LOCKFILE: Record<Manager, string> = {
  bun: 'bun.lock',
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
};

const INSTALL: Record<Manager, string> = {
  bun: 'bun install',
  npm: 'npm install',
  pnpm: 'pnpm install',
  yarn: 'yarn install',
};

const MANAGERS: Manager[] = ['bun', 'npm', 'pnpm', 'yarn'];

let seq = 0;
function uniq(prefix: string): string {
  return join(scratch, `${prefix}-${seq++}`);
}

function makeRepo(lockfiles: string[]): string {
  const dir = uniq('repo');
  mkdirSync(join(dir, '.git'), { recursive: true });
  for (const f of lockfiles) writeFileSync(join(dir, f), '');
  return dir;
}

function makeConfigHome(body?: string): string {
  const home = uniq('config');
  mkdirSync(join(home, 'agentkit'), { recursive: true });
  if (body !== undefined) writeFileSync(join(home, 'agentkit', 'config.yaml'), body);
  return home;
}

const emptyConfigHome = makeConfigHome();
const noLockRepo = makeRepo([]);

interface RunOpts {
  cwd?: string;
  xdg?: string;
  env?: Record<string, string>;
}

/** Denial text from the bash hook, or null when the command was allowed. */
function runHook(command: string, opts: RunOpts = {}): string | null {
  const result = spawnSync('bash', [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
    cwd: opts.cwd ?? noLockRepo,
    env: {
      ...process.env,
      AGENTKIT_ALLOW_PKG: '',
      XDG_CONFIG_HOME: opts.xdg ?? emptyConfigHome,
      ...(opts.env ?? {}),
    },
  });
  // A non-zero exit that is not 2 is a silently allowed command, so every path
  // through the hook must exit 0 — including the ones that die under `set -e`.
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${result.stderr ?? ''}`);
  }
  const stdout = result.stdout ?? '';
  if (!stdout.includes('"permissionDecision": "deny"')) return null;
  return JSON.parse(stdout).reason as string;
}

/** Denial text from the OpenCode plugin, or null when the command was allowed. */
async function runPlugin(command: string, opts: RunOpts = {}): Promise<string | null> {
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousAllow = process.env.AGENTKIT_ALLOW_PKG;
  process.env.XDG_CONFIG_HOME = opts.xdg ?? emptyConfigHome;
  delete process.env.AGENTKIT_ALLOW_PKG;
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const dir = opts.cwd ?? noLockRepo;
  try {
    const hooks = await pkgPolice({ directory: dir, worktree: dir } as never);
    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 'test', callID: 'test' },
      { args: { command } },
    );
    return null;
  } catch (error) {
    return (error as Error).message;
  } finally {
    for (const k of Object.keys(opts.env ?? {})) delete process.env[k];
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousAllow !== undefined) process.env.AGENTKIT_ALLOW_PKG = previousAllow;
  }
}

const IMPLS: Array<[string, (command: string, opts?: RunOpts) => Promise<string | null> | string | null]> = [
  ['claude hook', runHook],
  ['opencode plugin', runPlugin],
];

for (const [name, run] of IMPLS) {
  describe(`pkg-police auto mode (${name})`, () => {
    for (const enforced of MANAGERS) {
      test(`${LOCKFILE[enforced]} enforces ${enforced}`, async () => {
        const cwd = makeRepo([LOCKFILE[enforced]]);
        expect(await run(INSTALL[enforced], { cwd })).toBeNull();

        for (const other of MANAGERS.filter((m) => m !== enforced)) {
          const denial = await run(INSTALL[other], { cwd });
          expect(denial).toContain(INSTALL[other]);
          expect(denial).toContain(enforced);
          expect(denial).toContain(LOCKFILE[enforced]);
        }
      });
    }

    test('bun.lockb is recognised as bun', async () => {
      const cwd = makeRepo(['bun.lockb']);
      expect(await run('bun install', { cwd })).toBeNull();
      expect(await run('npm install', { cwd })).toContain('bun.lockb');
    });

    test('a lockfile above the working directory still enforces', async () => {
      const cwd = makeRepo([LOCKFILE.pnpm]);
      const nested = join(cwd, 'packages', 'app');
      mkdirSync(nested, { recursive: true });
      expect(await run('npm install', { cwd: nested })).toContain('pnpm-lock.yaml');
      expect(await run('pnpm install', { cwd: nested })).toBeNull();
    });

    test('no lockfile allows every manager', async () => {
      const cwd = makeRepo([]);
      for (const m of MANAGERS) expect(await run(INSTALL[m], { cwd })).toBeNull();
      expect(await run('npx tsc', { cwd })).toBeNull();
    });

    test('two competing lockfiles allow every manager', async () => {
      const cwd = makeRepo([LOCKFILE.npm, LOCKFILE.pnpm]);
      for (const m of MANAGERS) expect(await run(INSTALL[m], { cwd })).toBeNull();
    });

    test('the exec equivalents map across managers', async () => {
      const cwd = makeRepo([LOCKFILE.pnpm]);
      expect(await run('npx tsc --noEmit', { cwd })).toContain('pnpm dlx');
      expect(await run('bunx tsc --noEmit', { cwd })).toContain('pnpm dlx');
      expect(await run('pnpm dlx tsc --noEmit', { cwd })).toBeNull();
    });

    test('bare yarn and pnpm are treated as install', async () => {
      const cwd = makeRepo([LOCKFILE.npm]);
      expect(await run('yarn', { cwd })).toContain('npm install');
      expect(await run('pnpm', { cwd })).toContain('npm install');
    });

    test('subcommands that rewrite the manifest or lockfile are caught', async () => {
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('npm uninstall lodash', { cwd })).toContain('bun remove');
      expect(await run('npm rm lodash', { cwd })).toContain('bun remove');
      expect(await run('npm un lodash', { cwd })).toContain('bun remove');
      expect(await run('npm update', { cwd })).toContain('bun update');
      expect(await run('npm up', { cwd })).toContain('bun update');
      expect(await run('npm link ../lib', { cwd })).toContain('bun link');
      expect(await run('npm dedupe', { cwd })).toContain('bun install');
      expect(await run('npm prune', { cwd })).toContain('bun install');
      expect(await run('npm install-test', { cwd })).toContain('bun install');
      expect(await run('npm it', { cwd })).toContain('bun install');

      const npmRepo = makeRepo([LOCKFILE.npm]);
      expect(await run('bun remove lodash', { cwd: npmRepo })).toContain('npm remove');
      expect(await run('bun update', { cwd: npmRepo })).toContain('npm update');
    });

    test('npm shorthands are caught', async () => {
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('npm i lodash', { cwd })).toContain('bun add');
      expect(await run('npm ci', { cwd })).toContain('bun install');
      expect(await run('npm run build', { cwd })).toContain('bun run');
    });
  });

  describe(`pkg-police configured manager (${name})`, () => {
    test('manager: npm blocks bun in a bun repo', async () => {
      const xdg = makeConfigHome('pkg-police:\n  manager: npm\n');
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('npm install', { cwd, xdg })).toBeNull();
      const denial = await run('bun install', { cwd, xdg });
      expect(denial).toContain('bun install');
      expect(denial).toContain('npm install');
      expect(denial).toContain('config');
      expect(denial).not.toContain('bun.lock');
    });

    test('manager: off allows everything', async () => {
      const xdg = makeConfigHome('pkg-police:\n  manager: off\n');
      const cwd = makeRepo([LOCKFILE.bun]);
      for (const m of MANAGERS) expect(await run(INSTALL[m], { cwd, xdg })).toBeNull();
    });

    test('legacy enabled: false allows everything', async () => {
      const xdg = makeConfigHome('pkg-police:\n  enabled: false\n');
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('npm install', { cwd, xdg })).toBeNull();
    });

    test('manager wins over legacy enabled', async () => {
      const xdg = makeConfigHome('pkg-police:\n  enabled: false\n  manager: pnpm\n');
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('pnpm install', { cwd, xdg })).toBeNull();
      expect(await run('npm install', { cwd, xdg })).toContain('pnpm install');
    });

    test('manager: auto falls back to lockfile detection', async () => {
      const xdg = makeConfigHome('pkg-police:\n  manager: auto\n');
      const cwd = makeRepo([LOCKFILE.yarn]);
      expect(await run('yarn add react', { cwd, xdg })).toBeNull();
      expect(await run('npm install', { cwd, xdg })).toContain('yarn.lock');
    });

    test('an unknown manager fails safe and allows everything', async () => {
      const xdg = makeConfigHome('pkg-police:\n  manager: cargo\n');
      const cwd = makeRepo([LOCKFILE.bun]);
      for (const m of MANAGERS) expect(await run(INSTALL[m], { cwd, xdg })).toBeNull();
    });

    test('a quoted manager value is honored', async () => {
      const cwd = makeRepo([LOCKFILE.npm]);
      for (const body of ['pkg-police:\n  manager: "bun"\n', "pkg-police:\n  manager: 'bun'\n"]) {
        const xdg = makeConfigHome(body);
        expect(await run('bun install', { cwd, xdg })).toBeNull();
        const denial = await run('npm install', { cwd, xdg });
        expect(denial).toContain('bun install');
        expect(denial).toContain('config');
      }
    });

    test('a malformed manager value reads its first token', async () => {
      const xdg = makeConfigHome('pkg-police:\n  manager: npm oops\n');
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('npm install', { cwd, xdg })).toBeNull();
      expect(await run('bun install', { cwd, xdg })).toContain('npm install');
    });

    test('another section named manager is ignored', async () => {
      const xdg = makeConfigHome('coding-police:\n  manager: npm\n\npkg-police:\n  manager: pnpm\n');
      const cwd = makeRepo([]);
      expect(await run('npm install', { cwd, xdg })).toContain('pnpm install');
    });
  });

  describe(`pkg-police compound commands (${name})`, () => {
    test('a managed invocation later in the command is caught', async () => {
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('npm --version && npm install', { cwd })).toContain('bun install');
      expect(await run('npm ls && npm install', { cwd })).toContain('bun install');
      expect(await run('echo hello npm world; npm ci', { cwd })).toContain('bun install');
      expect(await run('true; npm install lodash', { cwd })).toContain('bun add');
    });

    test('an operator or quote after the command still counts as an invocation', async () => {
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('npm install && npm ls', { cwd })).toContain('bun install');
      expect(await run('npm install; echo done', { cwd })).toContain('bun install');
      expect(await run('npm install|tee log', { cwd })).toContain('bun install');
      expect(await run('bash -c "npm ci"', { cwd })).toContain('bun install');
      expect(await run("sh -c 'npm run build'", { cwd })).toContain('bun run');
      expect(await run('(npm install)', { cwd })).toContain('bun install');
    });

    test('a longer word starting with a managed subcommand is not an invocation', async () => {
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('npm installer', { cwd })).toBeNull();
      expect(await run('npm testing', { cwd })).toBeNull();
    });

    test('npm and bun subcommands outside package management are allowed', async () => {
      const bunRepo = makeRepo([LOCKFILE.bun]);
      expect(await run('npm whoami', { cwd: bunRepo })).toBeNull();
      expect(await run('npm view lodash version', { cwd: bunRepo })).toBeNull();
      expect(await run('npm ls', { cwd: bunRepo })).toBeNull();
      expect(await run('echo hello npm world', { cwd: bunRepo })).toBeNull();

      const npmRepo = makeRepo([LOCKFILE.npm]);
      expect(await run('bun ./script.ts', { cwd: npmRepo })).toBeNull();
      expect(await run('bun --version', { cwd: npmRepo })).toBeNull();
    });
  });

  describe(`pkg-police lockfile names (${name})`, () => {
    test('naming a lockfile is not an invocation', async () => {
      const cwd = makeRepo([LOCKFILE.bun]);
      for (const command of [
        'rm -f yarn.lock',
        'git add yarn.lock',
        'cat yarn.lock',
        'cat pnpm-lock.yaml',
        'rm yarn.lock pnpm-lock.yaml',
        'wc -l ./packages/app/yarn.lock',
      ]) {
        expect(await run(command, { cwd })).toBeNull();
      }
    });
  });

  describe(`pkg-police case-insensitivity (${name})`, () => {
    test('an uppercased manager still counts', async () => {
      const cwd = makeRepo([LOCKFILE.bun]);
      expect(await run('NPM install', { cwd })).toContain('bun install');
      expect(await run('NPX tsc', { cwd })).toContain('bunx');
      expect(await run('Npm Run build', { cwd })).toContain('bun run');
      const npmRepo = makeRepo([LOCKFILE.npm]);
      expect(await run('YARN add react', { cwd: npmRepo })).toContain('npm add');
    });
  });

  describe(`pkg-police lockfile walk (${name})`, () => {
    test('the walk stops at the git root', async () => {
      const outer = uniq('outer');
      const inner = join(outer, 'project');
      mkdirSync(join(inner, '.git'), { recursive: true });
      writeFileSync(join(outer, LOCKFILE.bun), '');
      // The bun.lock sits outside the repository, so nothing is enforced.
      for (const m of MANAGERS) expect(await run(INSTALL[m], { cwd: inner })).toBeNull();
    });
  });

  describe(`pkg-police override (${name})`, () => {
    test('inline AGENTKIT_ALLOW_PKG=1 allows the command', async () => {
      const cwd = makeRepo([LOCKFILE.pnpm]);
      expect(await run('AGENTKIT_ALLOW_PKG=1 npm ci', { cwd })).toBeNull();
    });

    test('environment AGENTKIT_ALLOW_PKG=1 allows the command', async () => {
      const cwd = makeRepo([LOCKFILE.pnpm]);
      expect(await run('npm ci', { cwd, env: { AGENTKIT_ALLOW_PKG: '1' } })).toBeNull();
    });

    test('unrelated assignments do not unlock the override', async () => {
      const cwd = makeRepo([LOCKFILE.pnpm]);
      expect(await run('AGENTKIT_ALLOW_PKG=10 npm ci', { cwd })).toContain('pnpm install');
    });

    test('the refusal names the override', async () => {
      const cwd = makeRepo([LOCKFILE.pnpm]);
      expect(await run('npm ci', { cwd })).toContain('AGENTKIT_ALLOW_PKG=1');
    });
  });
}
