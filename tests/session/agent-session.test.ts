import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(import.meta.dir));
const shim = join(repoRoot, 'tools', 'agent-session');

let root: string;
let shimDir: string;
let realDir: string;
let runtimeDir: string;
let systemdLog: string;

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function run(argv: string[], overrides: Record<string, string> = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shimDir}:${realDir}:/usr/bin:/bin`,
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtimeDir, 'bus')}`,
      AGENTKIT_SESSION_SCOPE: '',
      ...overrides,
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-session-'));
  shimDir = join(root, 'shims');
  realDir = join(root, 'real');
  runtimeDir = join(root, 'runtime');
  systemdLog = join(root, 'systemd.log');
  mkdirSync(shimDir);
  mkdirSync(realDir);
  mkdirSync(runtimeDir);

  writeFileSync(join(runtimeDir, 'bus'), '');

  writeExecutable(join(shimDir, 'agent-session'), readFileSync(shim, 'utf8'));
  symlinkSync('agent-session', join(shimDir, 'probecmd'));

  writeExecutable(join(realDir, 'probecmd'), '#!/bin/bash\necho "real probecmd $*"\n');

  // Stand-ins so the test never touches the real user systemd manager.
  writeExecutable(
    join(realDir, 'systemd-run'),
    `#!/bin/bash\necho "$@" >> ${systemdLog}\nwhile [[ $# -gt 0 ]]; do [[ "$1" == "--" ]] && { shift; break; }; shift; done\nexec "$@"\n`,
  );
  writeExecutable(join(realDir, 'systemctl'), '#!/bin/bash\nexit 0\n');
});

afterEach(() => {
  spawnSync('rm', ['-rf', root]);
});

describe('agent-session', () => {
  test('scopes the runtime when invoked through a shim symlink', () => {
    const result = run([join(shimDir, 'probecmd'), 'alpha']);
    expect(result.stdout).toContain('real probecmd alpha');

    const invocation = readFileSync(systemdLog, 'utf8');
    expect(invocation).toContain('--user');
    expect(invocation).toContain('--scope');
    expect(invocation).toContain('--slice=agent-sessions.slice');
    expect(invocation).toContain('TasksMax=4096');
  });

  test('supports the explicit agent-session <command> form', () => {
    const result = run([join(shimDir, 'agent-session'), 'probecmd', 'beta']);
    expect(result.stdout).toContain('real probecmd beta');
    expect(readFileSync(systemdLog, 'utf8')).toContain('--scope');
  });

  test('does not nest a second scope for a nested invocation', () => {
    const result = run([join(shimDir, 'probecmd'), 'gamma'], { AGENTKIT_SESSION_SCOPE: '1' });
    expect(result.stdout).toContain('real probecmd gamma');
    expect(() => readFileSync(systemdLog, 'utf8')).toThrow();
  });

  test('still runs the runtime when the user bus is unreachable', () => {
    const result = run([join(shimDir, 'probecmd'), 'delta'], {
      XDG_RUNTIME_DIR: join(root, 'absent'),
      DBUS_SESSION_BUS_ADDRESS: '',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('real probecmd delta');
    expect(() => readFileSync(systemdLog, 'utf8')).toThrow();
  });

  test('still runs the runtime when systemd-run is absent', () => {
    // A PATH holding the coreutils the shim needs, but deliberately no
    // systemd-run, so this exercises the absent branch and not a broken shim.
    const sandbox = join(root, 'sandbox-bin');
    mkdirSync(sandbox);
    for (const util of ['basename', 'dirname', 'readlink', 'id', 'stat']) {
      const found = spawnSync('command', ['-v', util], { encoding: 'utf8', shell: true }).stdout.trim();
      symlinkSync(found, join(sandbox, util));
    }
    symlinkSync(join(realDir, 'probecmd'), join(sandbox, 'probecmd'));

    const result = run([join(shimDir, 'probecmd'), 'epsilon'], { PATH: `${shimDir}:${sandbox}` });
    expect(result.stdout).toContain('real probecmd epsilon');
    expect(() => readFileSync(systemdLog, 'utf8')).toThrow();
  });

  test('resolves the runtime in the deployed topology: shim symlinks into a separate bin dir', () => {
    // What install.sh actually creates: shims/<runtime> -> <bin>/agent-session,
    // with the real runtime ALSO in <bin>. Resolving the symlink would make the
    // shim skip <bin> and never find the runtime.
    const binDir = join(root, 'bin');
    const deployedShims = join(root, 'deployed-shims');
    mkdirSync(binDir);
    mkdirSync(deployedShims);
    writeExecutable(join(binDir, 'agent-session'), readFileSync(shim, 'utf8'));
    writeExecutable(join(binDir, 'probecmd'), '#!/bin/bash\necho "real probecmd $*"\n');
    symlinkSync(join(binDir, 'agent-session'), join(deployedShims, 'probecmd'));
    // The systemd stand-ins must travel with binDir, because realDir is kept
    // OFF PATH so binDir is the only source of probecmd — a second copy there
    // would mask the skip-the-wrong-dir bug entirely.
    symlinkSync(join(realDir, 'systemd-run'), join(binDir, 'systemd-run'));
    symlinkSync(join(realDir, 'systemctl'), join(binDir, 'systemctl'));

    const result = run([join(deployedShims, 'probecmd'), 'deployed'], {
      PATH: `${deployedShims}:${binDir}:/usr/bin:/bin`,
    });

    expect(result.stderr).not.toContain('cannot find');
    expect(result.stdout).toContain('real probecmd deployed');
    expect(readFileSync(systemdLog, 'utf8')).toContain('--slice=agent-sessions.slice');
  });

  test('never resolves itself when the shim directory is duplicated on PATH', () => {
    const result = run([join(shimDir, 'probecmd'), 'zeta'], {
      PATH: `${shimDir}:${shimDir}:${realDir}:/usr/bin:/bin`,
    });
    expect(result.stdout).toContain('real probecmd zeta');
  });

  test('fails cleanly rather than looping when the runtime is missing', () => {
    const result = run([join(shimDir, 'probecmd'), 'eta'], { PATH: `${shimDir}:/usr/bin:/bin` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot find');
  });

  test('honours a conf we own', () => {
    const conf = join(root, 'session-guard.conf');
    writeFileSync(conf, 'TASKS_MAX=2048\nMEMORY_MAX=8G\n');
    const result = run([join(shimDir, 'probecmd'), 'theta'], { AGENTKIT_SESSION_CONF: conf });

    expect(result.status).toBe(0);
    const invocation = readFileSync(systemdLog, 'utf8');
    expect(invocation).toContain('TasksMax=2048');
    expect(invocation).toContain('MemoryMax=8G');
  });

  test('a value systemd would refuse never reaches systemd', () => {
    // systemd rejects the whole property and runs nothing, and the shim execs
    // into it — so an unvalidated typo here would stop the session starting.
    const conf = join(root, 'session-guard.conf');
    writeFileSync(conf, 'MEMORY_MAX=16GB\nTASKS_MAX=lots\n');
    const result = run([join(shimDir, 'probecmd'), 'kappa'], { AGENTKIT_SESSION_CONF: conf });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('real probecmd kappa');
    expect(result.stderr).toContain('not a valid systemd value');

    const invocation = readFileSync(systemdLog, 'utf8');
    expect(invocation).not.toContain('16GB');
    expect(invocation).not.toContain('lots');
    expect(invocation).toContain('MemoryMax=16G');
    expect(invocation).toContain('TasksMax=4096');
  });

  test('rejects conf values systemd would refuse, and keeps systemd-accepted ones', () => {
    // systemd rejecting a property means the payload never runs, and the shim
    // execs into it — so an unvalidated typo would stop every session starting.
    const probe = (fn: string, value: string) =>
      spawnSync('bash', ['-c', `. '${shim}'; ${fn} '${value}' && echo accept || echo reject`], {
        encoding: 'utf8',
      }).stdout.trim();

    for (const good of ['16G', '512M', '1024', 'infinity', '50%', '16 G']) {
      expect(`${good}:${probe('is_size_value', good)}`).toBe(`${good}:accept`);
    }
    for (const bad of ['notanumber', '16GB', '', 'G16']) {
      expect(`${bad}:${probe('is_size_value', bad)}`).toBe(`${bad}:reject`);
    }
    expect(probe('is_tasks_value', '4096')).toBe('accept');
    expect(probe('is_tasks_value', 'lots')).toBe('reject');
  });

  test('a missing session conf leaves the built-in defaults in place', () => {
    const result = run([join(shimDir, 'probecmd'), 'iota'], {
      AGENTKIT_SESSION_CONF: join(root, 'does-not-exist.conf'),
    });
    expect(result.status).toBe(0);
    expect(readFileSync(systemdLog, 'utf8')).toContain('TasksMax=4096');
  });
});
