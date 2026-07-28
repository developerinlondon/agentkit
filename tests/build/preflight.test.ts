import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TEST_SLICES } from '../../scripts/check-test-slices.ts';

const REPO = join(import.meta.dir, '..', '..');
const PREFLIGHT = join(REPO, 'scripts', 'preflight');
const STATUS_CHECK = join(REPO, 'scripts', 'bash-status-check');

let root: string;

function write(relative: string, body: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function preflight(paths: string[], extra: string[] = []): ReturnType<typeof spawnSync> {
  const list = join(root, '.touched');
  writeFileSync(list, `${paths.join('\n')}\n`);
  return spawnSync('bash', [PREFLIGHT, '--repo', root, '--paths-from', list, ...extra], {
    encoding: 'utf-8',
  });
}

const SHELL_PREAMBLE = ['#!/usr/bin/env bash', 'set -euo pipefail'];

function shellScript(lines: string[]): string {
  return [...SHELL_PREAMBLE, ...lines, ''].join('\n');
}

function statusCheck(...lines: string[]): ReturnType<typeof spawnSync> {
  const path = write('probe.sh', shellScript(lines));
  return spawnSync('bash', [STATUS_CHECK, path], { encoding: 'utf-8' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-preflight-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('conditional-and status leaks', () => {
  test('a function whose last command is `cond && action` is reported', () => {
    const result = statusCheck('f() {', '\tdeclared "$1" && printf ok', '}', 'f x');

    expect(result.stdout).toContain('[tail-leak]');
    expect(result.stdout).toContain('f() ends with a conditional-and');
    expect(result.status).toBe(1);
  });

  test('a loop body in tail position leaks through the enclosing function', () => {
    const result = statusCheck(
      'f() {',
      '\tfor e in "$@"; do',
      '\t\tdeclared "$e" && printf ok',
      '\tdone',
      '}',
      'f x',
    );

    expect(result.stdout).toContain('[tail-leak]');
    expect(result.status).toBe(1);
  });

  test('a gate reporting only success is reported wherever it sits', () => {
    const result = statusCheck(
      'if command -v tool >/dev/null; then',
      '\ttool validate "$DIR" && echo "manifest valid"',
      'fi',
      'printf done',
    );

    expect(result.stdout).toContain('[soft-gate]');
    expect(result.status).toBe(1);
  });

  test('splitting a gate across two physical lines does not hide it', () => {
    const result = statusCheck(
      'run() {',
      '\ttool validate "$1" \\',
      '\t\t&& echo "valid"',
      '\tprintf reached',
      '\treturn 0',
      '}',
      'run x',
    );

    expect(result.stdout).toContain('[soft-gate]');
    expect(result.status).toBe(1);
  });

  test('a && inside a command substitution is not a statement-level gate', () => {
    const result = statusCheck('captured() {', '\tlocal v', '\tv="$(a && b)"', '}', 'captured');

    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  test('the repaired shapes are accepted, so the check is not a blanket ban on &&', () => {
    const result = statusCheck(
      'predicate() {',
      '\tprintf "%s" "$LIST" | grep -qx "$1"',
      '}',
      'guarded() {',
      '\t[[ -n "$1" ]] && printf y || printf n',
      '}',
      'captured() {',
      '\tlocal v',
      '\tv="$(a && b)"',
      '\tprintf "%s" "$v"',
      '}',
      'repaired() {',
      '\tif ! tool validate "$1"; then',
      '\t\tprintf invalid >&2',
      '\t\texit 1',
      '\tfi',
      '}',
      'oneline() {',
      '\tif check && other; then printf y; fi',
      '}',
      'wrapped() {',
      '\tif probe &&',
      '\t\tcheck && echo found; then',
      '\t\tprintf y',
      '\tfi',
      '\treturn 0',
      '}',
      'repaired x',
    );

    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  test('a heredoc body is not scanned as code', () => {
    const lines = ['emit() {', '\tcat <<-TXT', '\t\tusage:', '\t\trun check && echo ok', '\tTXT', '\treturn 0', '}', 'emit'];

    expect(statusCheck(...lines).stdout).toBe('');
    expect(statusCheck(...lines).status).toBe(0);

    // The same text outside a heredoc must fire, or the case above proves nothing.
    const asCode = lines.filter((line) => !line.includes('<<-TXT') && line.trim() !== 'TXT');
    expect(statusCheck(...asCode).stdout).toContain('[soft-gate]');
    expect(statusCheck(...asCode).status).toBe(1);
  });

  test('preflight fails on a planted tail, and passes once it is repaired', () => {
    write('hooks/leak.sh', shellScript(['f() {', '\tdeclared "$1" && printf ok', '}', 'f x']));
    const planted = preflight(['hooks/leak.sh']);
    expect(planted.stdout).toContain('conditional-and status leak');
    expect(planted.status).toBe(1);

    write(
      'hooks/leak.sh',
      shellScript(['f() {', '\tif declared "$1"; then', '\t\tprintf ok', '\tfi', '\treturn 0', '}', 'f x']),
    );
    const repaired = preflight(['hooks/leak.sh']);
    expect(repaired.stdout).toContain('no conditional-and status leaks');
    expect(repaired.status).toBe(0);
  });
});

describe('plugin mirror parity', () => {
  test('drift between a skill and its plugin mirror fails', () => {
    write('skills/demo/SKILL.md', '# demo\n');
    write('plugins-cc/agentkit/skills/demo/SKILL.md', '# demo drifted\n');

    const result = preflight(['skills/demo/SKILL.md']);

    expect(result.stdout).toContain('mirror drift');
    expect(result.stdout).toContain('sync-cc-plugin.sh');
    expect(result.status).toBe(1);
  });

  test('a missing mirror fails', () => {
    write('skills/demo/SKILL.md', '# demo\n');

    const result = preflight(['skills/demo/SKILL.md']);

    expect(result.stdout).toContain('mirror missing');
    expect(result.status).toBe(1);
  });

  test('byte-identical mirrors pass', () => {
    write('skills/demo/SKILL.md', '# demo\n');
    write('plugins-cc/agentkit/skills/demo/SKILL.md', '# demo\n');

    const result = preflight(['skills/demo/SKILL.md']);

    expect(result.stdout).toContain('plugin mirror byte-identical');
    expect(result.status).toBe(0);
  });
});

describe('test slice routing', () => {
  function sliceRepo(): void {
    cpSync(join(REPO, 'scripts', 'check-test-slices.ts'), write('scripts/check-test-slices.ts', ''));
    cpSync(join(REPO, 'moon.yml'), write('moon.yml', ''));
    for (const files of Object.values(TEST_SLICES)) {
      for (const file of files) write(file, '');
    }
  }

  test('an unrouted new test file fails', () => {
    sliceRepo();
    write('tests/brand-new.test.ts', '');

    const result = preflight(['tests/brand-new.test.ts']);

    expect(result.stdout).toContain('unassigned test: tests/brand-new.test.ts');
    expect(result.stdout).toContain('runs in no CI slice');
    expect(result.status).toBe(1);
  });

  test('a repository whose tests are all routed passes', () => {
    sliceRepo();

    const result = preflight(['moon.yml']);

    expect(result.stdout).toContain('test slice routing:');
    expect(result.status).toBe(0);
  });

  test('--slice fails the gate when the slice goes red', () => {
    sliceRepo();
    write(
      'tests/build/mutate.test.ts',
      ["import { expect, test } from 'bun:test';", "test('fails', () => expect(1).toBe(2));", ''].join('\n'),
    );

    const result = preflight(['moon.yml'], ['--slice', 'review']);

    expect(result.stdout).toContain('1 fail');
    expect(result.status).toBe(1);
  });

  test('--slice reports a run that printed no marker as a fault, not a pass', () => {
    sliceRepo();

    const result = preflight(['moon.yml'], ['--slice', 'no-such-slice']);

    expect(result.stdout).toContain('printed no pass/fail marker');
    expect(result.status).toBe(1);
  });
});

describe('pattern checks', () => {
  test('a focused or skipped test fails', () => {
    write('tests/demo.test.ts', "test.only('x', () => {});\n");

    const result = preflight(['tests/demo.test.ts']);

    expect(result.stdout).toContain('focused or skipped test');
    expect(result.status).toBe(1);
  });

  test('a focused-test call quoted as fixture data is not a focused test', () => {
    write('tests/demo.test.ts', ['const fixture = "test.only(\'x\', () => {});";', 'export default fixture;', ''].join('\n'));

    const result = preflight(['tests/demo.test.ts']);

    expect(result.stdout).toContain('no focused or skipped tests');
    expect(result.status).toBe(0);
  });

  test('restoring a mutation with git fails', () => {
    write('scripts/probe.sh', '#!/usr/bin/env bash\ngit checkout -- src/thing.ts\n');

    const result = preflight(['scripts/probe.sh']);

    expect(result.stdout).toContain('restores with git');
    expect(result.status).toBe(1);
  });

  test('a missing-dependency test that leaves bun auto-install enabled fails', () => {
    write(
      'tests/render.test.ts',
      [
        "const result = spawnSync('bun', [script, dir], { encoding: 'utf-8' });",
        "expect(result.stderr).toContain('Cannot find package');",
        '',
      ].join('\n'),
    );

    const result = preflight(['tests/render.test.ts']);

    expect(result.stdout).toContain('auto-install live');
    expect(result.status).toBe(1);
  });

  test('the same test passes once it disables auto-install', () => {
    write(
      'tests/render.test.ts',
      [
        "const result = spawnSync('bun', ['--no-install', script, dir], { encoding: 'utf-8' });",
        "expect(result.stderr).toContain('Cannot find package');",
        '',
      ].join('\n'),
    );

    const result = preflight(['tests/render.test.ts']);

    expect(result.stdout).toContain('no negative-path test leaves');
    expect(result.status).toBe(0);
  });

  test('a missing-dependency assertion with no bun spawn is left alone', () => {
    write(
      'tests/render.test.ts',
      ["expect(() => load(dir)).toThrow('Cannot find package');", ''].join('\n'),
    );

    const result = preflight(['tests/render.test.ts']);

    expect(result.stdout).toContain('no negative-path test leaves');
    expect(result.status).toBe(0);
  });

  test('a bun spawn that asserts nothing about a missing dependency is left alone', () => {
    write('tests/render.test.ts', ["const result = spawnSync('bun', [script, dir]);", ''].join('\n'));

    const result = preflight(['tests/render.test.ts']);

    expect(result.stdout).toContain('no negative-path test leaves');
    expect(result.status).toBe(0);
  });

  test('a git restore quoted as fixture data is not a restore', () => {
    write('tests/demo.test.ts', ['const fixture = "git checkout -- src/thing.ts";', 'export default fixture;', ''].join('\n'));

    const result = preflight(['tests/demo.test.ts']);

    expect(result.stdout).toContain('no git-checkout restores');
    expect(result.status).toBe(0);
  });

  test('a bare dprint invocation fails', () => {
    write('scripts/probe.sh', '#!/usr/bin/env bash\ndprint fmt\n');

    const result = preflight(['scripts/probe.sh']);

    expect(result.stdout).toContain('no file list');
    expect(result.status).toBe(1);
  });

  test('a test spawning an installer with the inherited environment fails', () => {
    write(
      'tests/install-demo.test.ts',
      ["spawnSync('bash', [join(REPO, 'install.sh')], {", '  env: { ...process.env },', '});', ''].join('\n'),
    );

    const result = preflight(['tests/install-demo.test.ts']);

    expect(result.stdout).toContain('writes the real $HOME');
    expect(result.status).toBe(1);
  });

  test('the same test passes once it overrides HOME', () => {
    write(
      'tests/install-demo.test.ts',
      ["spawnSync('bash', [join(REPO, 'install.sh')], {", '  env: { ...process.env, HOME: home },', '});', ''].join('\n'),
    );

    const result = preflight(['tests/install-demo.test.ts']);

    expect(result.stdout).toContain('no test spawns an installer');
    expect(result.status).toBe(0);
  });

  test('a pattern named in a comment is described, not committed', () => {
    write('scripts/probe.sh', '#!/usr/bin/env bash\n# never restore with git checkout -- path\nprintf ok\n');

    const result = preflight(['scripts/probe.sh']);

    expect(result.stdout).toContain('no git-checkout restores');
    expect(result.status).toBe(0);
  });
});

describe('formatting', () => {
  const UNFORMATTED = '{"a":1,"b":2}\n';

  function git(...args: string[]): void {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
  }

  test('drift that predates the change is left alone, but new drift fails', () => {
    cpSync(join(REPO, 'dprint.json'), join(root, 'dprint.json'));
    write('inherited.json', UNFORMATTED);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-qm', 'base');

    write('added.json', UNFORMATTED);
    const list = join(root, '.touched');
    writeFileSync(list, 'inherited.json\nadded.json\n');
    const result = spawnSync(
      'bash',
      [PREFLIGHT, '--repo', root, '--base', 'HEAD', '--paths-from', list],
      { encoding: 'utf-8' },
    );

    expect(result.stdout).toContain('already unformatted before this change');
    expect(result.stdout).toContain('inherited.json');
    expect(result.stdout).toContain('dprint fmt added.json');
    expect(result.status).toBe(1);
  });
});

describe('invocation', () => {
  test('a syntactically broken shell file fails', () => {
    const path = write('scripts/broken.sh', '#!/usr/bin/env bash\nf() {\nprintf ok\n');
    chmodSync(path, 0o755);

    const result = preflight(['scripts/broken.sh']);

    expect(result.stdout).toContain('does not parse');
    expect(result.status).toBe(1);
  });

  test('an empty touched set is not an error', () => {
    const result = preflight([]);

    expect(result.status).toBe(0);
  });

  test('--help explains the invocation and exits clean', () => {
    const result = spawnSync('bash', [PREFLIGHT, '--help'], { encoding: 'utf-8' });

    expect(result.stderr).toContain('usage: preflight');
    expect(result.status).toBe(0);
  });
});
