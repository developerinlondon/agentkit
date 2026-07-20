import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const installScript = join(repoRoot, 'install.sh');

describe('standalone tool installation', () => {
  test('installs global tools into PATH and preserves the Claude tools mirror', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-tools-'));

    try {
      const result = spawnSync('bash', [installScript, '--global'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
        },
        encoding: 'utf-8',
      });
      expect(result.status, result.stderr).toBe(0);

      const pathTool = join(home, '.local', 'bin', 'bounded-run');
      const claudeTool = join(home, '.claude', 'tools', 'bounded-run');
      expect(readFileSync(pathTool, 'utf-8')).toBe(readFileSync(claudeTool, 'utf-8'));
      expect(statSync(pathTool).mode & 0o111).not.toBe(0);
      expect(statSync(claudeTool).mode & 0o111).not.toBe(0);
      const compatAlias = join(home, '.local', 'bin', 'agentkit-run');
      expect(lstatSync(compatAlias).isSymbolicLink()).toBe(true);
      expect(readFileSync(compatAlias, 'utf-8')).toBe(readFileSync(pathTool, 'utf-8'));
      expect(result.stdout).toContain(`PATH tools:      ${join(home, '.local', 'bin')}/`);
      expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'resource-police.ts'))).toBe(
        true,
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('ships the runner inside the one-shot Claude plugin', () => {
    const source = readFileSync(join(repoRoot, 'tools', 'bounded-run'), 'utf-8');
    const bundled = join(repoRoot, 'plugins-cc', 'agentkit', 'tools', 'bounded-run');
    expect(readFileSync(bundled, 'utf-8')).toBe(source);
    expect(statSync(bundled).mode & 0o111).not.toBe(0);
  });
});

const installEnv = (home: string, platform?: string) => {
  // Inherited AGENTKIT_PLATFORM would silently defeat the no-override test.
  const { AGENTKIT_PLATFORM: _ignored, ...rest } = process.env;
  return {
    ...rest,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    ...(platform === undefined ? {} : { AGENTKIT_PLATFORM: platform }),
  };
};

const runInstall = (home: string, platform?: string) =>
  spawnSync('bash', [installScript, '--global'], {
    cwd: repoRoot,
    env: installEnv(home, platform),
    encoding: 'utf-8',
  });

// Exercising the directive grammar needs tools the repo does not ship, so stand
// up a repo whose tools/ we control and symlink everything else back to the real
// tree. REPO_DIR follows install.sh's own path, so the fixture tools/ wins.
const withFixtureTools = (
  tools: Record<string, string>,
  body: (
    run: (platform?: string) => ReturnType<typeof spawnSync>,
    home: string,
    repo: string,
  ) => void,
) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentkit-fixture-'));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(repo);
  mkdirSync(home);

  for (const entry of readdirSync(repoRoot)) {
    if (entry !== 'tools') symlinkSync(join(repoRoot, entry), join(repo, entry));
  }
  mkdirSync(join(repo, 'tools'));
  for (const [name, content] of Object.entries(tools)) {
    const tool = join(repo, 'tools', name);
    writeFileSync(tool, content);
    chmodSync(tool, 0o755);
  }

  const run = (platform?: string) =>
    spawnSync('bash', [join(repo, 'install.sh'), '--global'], {
      cwd: repo,
      env: installEnv(home, platform),
      encoding: 'utf-8',
    });

  try {
    body(run, home, repo);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

// existsSync follows symlinks, so it reports false for a dangling link that is
// still on disk. Gating has to remove the link itself, not just its target.
const pathPresent = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const withHome = (body: (home: string) => void) => {
  const home = mkdtempSync(join(tmpdir(), 'agentkit-platform-'));
  try {
    body(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
};

// bounded-run drives systemd-run and cgroupfs directly, so installing it on a
// non-Linux host hands the agent a command that cannot work.
describe('tool platform gating', () => {
  test('does not install a Linux-only tool on a darwin host', () => {
    withHome((home) => {
      const result = runInstall(home, 'darwin');
      expect(result.status, result.stderr).toBe(0);

      expect(existsSync(join(home, '.local', 'bin', 'bounded-run'))).toBe(false);
      expect(existsSync(join(home, '.claude', 'tools', 'bounded-run'))).toBe(false);
      expect(result.stdout).toContain('Skipping (unsupported on darwin): bounded-run');
    });
  });

  // Removal of an already-present alias is covered by the reconcile test below;
  // on a fresh skip there is nothing to remove, only something not to create.
  test('does not create the agentkit-run alias when its target is skipped', () => {
    withHome((home) => {
      expect(runInstall(home, 'darwin').status).toBe(0);
      expect(pathPresent(join(home, '.local', 'bin', 'agentkit-run'))).toBe(false);
    });
  });

  test('installs tools that declare no platforms everywhere', () => {
    withHome((home) => {
      expect(runInstall(home, 'darwin').status).toBe(0);
      expect(existsSync(join(home, '.local', 'bin', 'fix-ascii-boxes.py'))).toBe(true);
    });
  });

  test('removes a tool already installed before it declared its platforms', () => {
    withHome((home) => {
      expect(runInstall(home, 'linux').status).toBe(0);
      const tool = join(home, '.local', 'bin', 'bounded-run');
      const alias = join(home, '.local', 'bin', 'agentkit-run');
      expect(existsSync(tool)).toBe(true);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);

      // Same host, later agentkit version: the gate must reconcile, not just skip.
      expect(runInstall(home, 'darwin').status).toBe(0);
      expect(pathPresent(tool)).toBe(false);
      expect(pathPresent(join(home, '.claude', 'tools', 'bounded-run'))).toBe(false);
      expect(pathPresent(alias)).toBe(false);
    });
  });

  test.skipIf(process.platform !== 'linux')('detects the host platform when no override is set', () => {
    withHome((home) => {
      const result = runInstall(home);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(home, '.local', 'bin', 'bounded-run'))).toBe(true);
      expect(result.stdout).not.toContain('Skipping (unsupported');
    });
  });

  test('rejects a platform override it does not recognise', () => {
    withHome((home) => {
      const result = runInstall(home, 'Linux');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("AGENTKIT_PLATFORM='Linux' is not one of");
      // A typo must not be read as "supports nothing" and delete the tools.
      expect(pathPresent(join(home, '.local', 'bin', 'bounded-run'))).toBe(false);
    });
  });
});

const toolWith = (directive: string, eol = '\n') =>
  ['#!/usr/bin/env bash', directive, 'echo fixture'].join(eol) + eol;

describe('platform directive grammar', () => {
  test('honours every platform a tool declares', () => {
    withFixtureTools({ dual: toolWith('# agentkit:platforms linux darwin') }, (run, home) => {
      for (const platform of ['linux', 'darwin']) {
        expect(run(platform).status).toBe(0);
        expect(existsSync(join(home, '.local', 'bin', 'dual'))).toBe(true);
      }
      // Still a real gate, not a match-anything.
      expect(run('unknown').status).toBe(0);
      expect(pathPresent(join(home, '.local', 'bin', 'dual'))).toBe(false);
    });
  });

  // Every spelling of "named nothing usable" has to behave the same, or the
  // outcome depends on how the author wrote their comment.
  for (const [label, directive] of [
    ['no values at all', '# agentkit:platforms'],
    ['commented-out value', '# agentkit:platforms #linux'],
    ['commented-out value, spaced', '# agentkit:platforms # linux'],
    ['double hash', '# agentkit:platforms ## linux'],
  ] as const) {
    test(`withholds rather than installs when a directive names nothing (${label})`, () => {
      withFixtureTools({ empty: toolWith(directive) }, (run, home) => {
        const result = run('linux');
        expect(result.status).toBe(0);
        expect(result.stderr).toContain('no usable platforms');
        expect(pathPresent(join(home, '.local', 'bin', 'empty'))).toBe(false);
      });
    });
  }

  test('reads a directive written with CRLF line endings', () => {
    withFixtureTools({ crlf: toolWith('# agentkit:platforms linux', '\r\n') }, (run, home) => {
      expect(run('linux').status).toBe(0);
      expect(existsSync(join(home, '.local', 'bin', 'crlf'))).toBe(true);
    });
  });

  test('treats directive values literally rather than globbing them', () => {
    withFixtureTools({ star: toolWith('# agentkit:platforms *') }, (run, home, repo) => {
      // Bait: an unquoted expansion globs against the working directory and
      // would turn '*' into this filename, matching the host platform.
      writeFileSync(join(repo, 'linux'), '');

      const result = run('linux');
      expect(result.status).toBe(0);
      expect(pathPresent(join(home, '.local', 'bin', 'star'))).toBe(false);
    });
  });

  test('does not read a trailing comment as platform names', () => {
    withFixtureTools({ noted: toolWith('# agentkit:platforms darwin # not linux') }, (run, home) => {
      expect(run('linux').status).toBe(0);
      expect(pathPresent(join(home, '.local', 'bin', 'noted'))).toBe(false);
    });
  });

  test('finds a directive that is indented', () => {
    withFixtureTools({ indented: toolWith('  # agentkit:platforms darwin') }, (run, home) => {
      expect(run('linux').status).toBe(0);
      expect(pathPresent(join(home, '.local', 'bin', 'indented'))).toBe(false);
    });
  });

  test('accepts the singular spelling rather than silently ignoring it', () => {
    withFixtureTools({ singular: toolWith('# agentkit:platform linux') }, (run, home) => {
      expect(run('darwin').status).toBe(0);
      expect(pathPresent(join(home, '.local', 'bin', 'singular'))).toBe(false);
      expect(run('linux').status).toBe(0);
      expect(existsSync(join(home, '.local', 'bin', 'singular'))).toBe(true);
    });
  });
});
