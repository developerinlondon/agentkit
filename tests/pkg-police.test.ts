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

    test('another section named manager is ignored', async () => {
      const xdg = makeConfigHome('coding-police:\n  manager: npm\n\npkg-police:\n  manager: pnpm\n');
      const cwd = makeRepo([]);
      expect(await run('npm install', { cwd, xdg })).toContain('pnpm install');
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
