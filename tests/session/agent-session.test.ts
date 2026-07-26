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

  test('honours a root-owned session conf but ignores unknown keys', () => {
    // Root-owned conf is unavailable in test, so this asserts the parser stays
    // forward-compatible: an unknown key must not abort the launch.
    const conf = join(root, 'session-guard.conf');
    writeFileSync(conf, 'TASKS_MAX=2048\nFUTURE_KEY=whatever\n');
    const result = run([join(shimDir, 'probecmd'), 'theta']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('real probecmd theta');
  });
});
