import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(import.meta.dir));
const notice = join(repoRoot, 'hooks', 'claude', 'update-notice.sh');

function sh(command: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', command], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

// A local remote the check can ls-remote without the network.
function remoteWithTags(tags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentkit-remote-'));
  sh(
    `cd "${dir}" && git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x`
      + tags.map((t) => ` && git tag ${t}`).join(''),
  );
  return dir;
}

function home(installed?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentkit-notice-'));
  mkdirSync(join(dir, '.agentkit'), { recursive: true });
  if (installed) writeFileSync(join(dir, '.agentkit', 'version'), `${installed}\ninstalled_at=x\n`);
  return dir;
}

function runNotice(homeDir: string, remote: string) {
  return sh(`"${notice}"`, {
    HOME: homeDir,
    AGENTKIT_HOME: join(homeDir, '.agentkit'),
    AGENTKIT_UPDATE_REMOTE: remote,
  });
}

describe('the session-start update notice', () => {
  test('names both versions when the remote is ahead', () => {
    const h = home('v0.5.0');
    const remote = remoteWithTags(['v0.5.0', 'v0.5.2', 'v0.4.9']);
    try {
      const r = runNotice(h, remote);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('v0.5.0 installed');
      expect(r.stdout).toContain('v0.5.2 is available');
    } finally {
      rmSync(h, { force: true, recursive: true });
      rmSync(remote, { force: true, recursive: true });
    }
  });

  function expectSilence(h: string, remote: string) {
    try {
      const r = runNotice(h, remote);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      rmSync(h, { force: true, recursive: true });
      if (remote.includes('agentkit-remote-')) rmSync(remote, { force: true, recursive: true });
    }
  }

  test('says nothing when the installed version is current', () => {
    expectSilence(home('v0.5.2'), remoteWithTags(['v0.5.2']));
  });

  // v0.4.9 vs v0.4.10 is the lexical-sort trap; the numeric field sort must
  // also refuse to call an OLDER remote "available" (a rollback is not news).
  test('orders versions numerically, and an older remote stays silent', () => {
    expectSilence(home('v0.4.10'), remoteWithTags(['v0.4.9']));
  });

  test('a missing stamp, a sha stamp, and an unreachable remote are all silence', () => {
    const noStamp = home();
    const shaStamp = home('abc1234');
    const unreachable = home('v0.1.0');
    try {
      for (const [h, remote] of [
        [noStamp, remoteWithTags(['v9.9.9'])],
        [shaStamp, remoteWithTags(['v9.9.9'])],
        [unreachable, '/nonexistent/remote'],
      ] as const) {
        const r = runNotice(h, remote);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toBe('');
      }
    } finally {
      for (const d of [noStamp, shaStamp, unreachable]) rmSync(d, { force: true, recursive: true });
    }
  });

  // timeout(1) is GNU coreutils; stock macOS has neither it nor gtimeout. The
  // first cut of this hook died silently there — command-not-found inside the
  // substitution reads as "no update". The bound must be optional.
  test('a PATH without timeout or gtimeout still notices an update', () => {
    const h = home('v0.1.0');
    const remote = remoteWithTags(['v0.2.0']);
    const bin = mkdtempSync(join(tmpdir(), 'agentkit-thinpath-'));
    try {
      for (const tool of ['bash', 'git', 'awk', 'grep', 'sed', 'sort', 'tail', 'head', 'date', 'dirname', 'printf']) {
        const located = sh(`command -v ${tool}`).stdout.trim();
        if (located) sh(`ln -s "${located}" "${join(bin, tool)}"`);
      }
      const r = spawnSync('bash', [notice], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          PATH: bin,
          HOME: h,
          AGENTKIT_HOME: join(h, '.agentkit'),
          AGENTKIT_UPDATE_REMOTE: remote,
        },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('v0.2.0 is available');
    } finally {
      for (const d of [h, remote, bin]) rmSync(d, { force: true, recursive: true });
    }
  });

  // A failed check must be remembered, or every session start on an offline
  // machine pays a fresh network attempt forever.
  test('a failed check writes a negative cache that later runs honour', () => {
    const h = home('v0.1.0');
    try {
      const first = runNotice(h, '/nonexistent/remote');
      expect(first.status).toBe(0);
      expect(first.stdout).toBe('');
      const cache = readFileSync(join(h, '.agentkit', '.update-check'), 'utf-8');
      expect(cache.trim()).toMatch(/^\d+ -$/);

      const second = runNotice(h, '/nonexistent/remote');
      expect(second.status).toBe(0);
      expect(second.stdout).toBe('');
    } finally {
      rmSync(h, { force: true, recursive: true });
    }
  });

  test('a fresh cache answers without touching the remote', () => {
    const h = home('v0.1.0');
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(h, '.agentkit', '.update-check'), `${now} v0.2.0\n`);
    try {
      // The remote does not exist: only the cache can supply the answer.
      const r = runNotice(h, '/nonexistent/remote');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('v0.2.0 is available');
    } finally {
      rmSync(h, { force: true, recursive: true });
    }
  });

  test('a stale cache is refreshed from the remote', () => {
    const h = home('v0.1.0');
    writeFileSync(join(h, '.agentkit', '.update-check'), `1000 v0.0.1\n`);
    const remote = remoteWithTags(['v0.3.0']);
    try {
      const r = runNotice(h, remote);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('v0.3.0 is available');
      expect(readFileSync(join(h, '.agentkit', '.update-check'), 'utf-8')).toContain('v0.3.0');
    } finally {
      rmSync(h, { force: true, recursive: true });
      rmSync(remote, { force: true, recursive: true });
    }
  });
});

describe('the installed version stamp', () => {
  function installGlobally(h: string) {
    return spawnSync(
      'bash',
      [join(repoRoot, 'install.sh'), '--global', '--no-session-scope', '--no-prompt'],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 120_000,
        env: {
          ...process.env,
          AGENTKIT_PLATFORM: 'linux',
          HOME: h,
          XDG_CONFIG_HOME: join(h, '.config'),
          AGENTKIT_HOME: join(h, '.agentkit'),
          CODEX_HOME: join(h, '.codex'),
        },
      },
    );
  }

  test('a global install stamps the resolved version', () => {
    const h = mkdtempSync(join(tmpdir(), 'agentkit-stamp-'));
    try {
      const r = installGlobally(h);
      expect(r.status, r.stderr).toBe(0);
      const stamp = readFileSync(join(h, '.agentkit', 'version'), 'utf-8');
      expect(stamp.split('\n')[0]).toMatch(/^(v\d+\.\d+\.\d+|[0-9a-f]{7,})/);
      expect(stamp).toContain('installed_at=');
      // The hook landed and the wiring appended SessionStart without clobbering
      // a foreign entry present before the install.
      expect(existsSync(join(h, '.agentkit', 'hooks', 'update-notice.sh'))).toBe(true);
    } finally {
      rmSync(h, { force: true, recursive: true });
    }
  }, 120_000);

  test('SessionStart wiring appends beside a foreign hook, once, across reruns', () => {
    const h = mkdtempSync(join(tmpdir(), 'agentkit-stamp-'));
    try {
      const settings = join(h, '.claude', 'settings.json');
      mkdirSync(dirname(settings), { recursive: true });
      writeFileSync(
        settings,
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool.sh' }] }] },
        }),
      );
      for (let i = 0; i < 2; i += 1) {
        const r = installGlobally(h);
        expect(r.status, r.stderr).toBe(0);
      }
      const wired = JSON.parse(readFileSync(settings, 'utf-8'));
      const flat = wired.hooks.SessionStart.flatMap((g: any) => g.hooks ?? []);
      expect(flat.filter((e: any) => e.command === 'other-tool.sh')).toHaveLength(1);
      expect(flat.filter((e: any) => String(e.command).includes('update-notice.sh'))).toHaveLength(1);
    } finally {
      rmSync(h, { force: true, recursive: true });
    }
  }, 240_000);
});
