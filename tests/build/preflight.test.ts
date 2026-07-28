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

function preflight(
  paths: string[],
  extra: string[] = [],
  env: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const list = join(root, '.touched');
  writeFileSync(list, `${paths.join('\n')}\n`);
  return spawnSync('bash', [PREFLIGHT, '--repo', root, '--paths-from', list, ...extra], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

// Puts a stub ahead of the real tool so a broken sub-tool can be simulated.
function stubOnPath(name: string, body: string): Record<string, string> {
  const bin = join(root, '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
  return { PATH: `${bin}:${process.env.PATH ?? ''}` };
}

const SHELL_PREAMBLE = ['#!/usr/bin/env bash', 'set -euo pipefail'];

function git(...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  expect(result.status, result.stderr).toBe(0);
}

function commitBase(): void {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'base');
}

function fixtureRepo(files: Record<string, string>): void {
  cpSync(join(REPO, 'dprint.json'), join(root, 'dprint.json'));
  for (const [name, body] of Object.entries(files)) write(name, body);
  commitBase();
}

function preflightAt(base: string, paths: string[]): ReturnType<typeof spawnSync> {
  const list = join(root, '.touched');
  writeFileSync(list, `${paths.join('\n')}\n`);
  return spawnSync('bash', [PREFLIGHT, '--repo', root, '--base', base, '--paths-from', list], {
    encoding: 'utf-8',
  });
}

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

  test('a scan that could not run exits 2, distinct from findings', () => {
    const clean = statusCheck('printf ok');
    const findings = statusCheck('f() {', '\tdeclared "$1" && printf ok', '}', 'f x');
    const failed = spawnSync('bash', [STATUS_CHECK, join(root, 'no-such-file.sh')], {
      encoding: 'utf-8',
    });

    expect(clean.status).toBe(0);
    expect(findings.status).toBe(1);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain('scan failed');
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

describe('cross-skill imports', () => {
  function skillPair(spec: string): ReturnType<typeof spawnSync> {
    const body = `import { render } from '${spec}';\nexport const x = render;\n`;
    write('skills/alpha/scripts/render.ts', body);
    write('plugins-cc/agentkit/skills/alpha/scripts/render.ts', body);
    write('skills/beta/slides.ts', 'export const render = 1;\n');
    return preflight(['skills/alpha/scripts/render.ts']);
  }

  test('an import reaching into another skill fails', () => {
    const result = skillPair('../../beta/slides.ts');

    expect(result.stdout).toContain('outside skills/alpha');
    expect(result.status).toBe(1);
  });

  test('an import inside the same skill passes', () => {
    const result = skillPair('./slides.ts');

    expect(result.stdout).toContain('no skill imports across a skill boundary');
    expect(result.status).toBe(0);
  });

  test('byte parity is satisfied by a faithfully copied broken import', () => {
    // The mirror is identical either way: parity proves sameness, not loadability,
    // so it cannot be the check that catches this.
    expect(skillPair('../../beta/slides.ts').stdout).toContain('plugin mirror byte-identical');
    expect(skillPair('./slides.ts').stdout).toContain('plugin mirror byte-identical');
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

    expect(result.stdout).toContain('discards working-tree state');
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

  test('a restore run from a test file is caught whatever the spelling', () => {
    const restore = ['git', 'checkout', '--', 'src/thing.ts'].join(' ');
    for (const line of [`execSync("${restore}");`, `await $\`${restore}\`;`, `spawnSync('bash', ['-c', '${restore}']);`]) {
      write('tests/a.test.ts', `${line}\n`);
      const result = preflight(['tests/a.test.ts']);
      expect(result.stdout, line).toContain('discards working-tree state');
      expect(result.status, line).toBe(1);
    }
  });

  test('the other discard spellings are caught in a shell file', () => {
    for (const line of ['git checkout HEAD -- src/thing.ts', 'git stash --keep-index', 'git clean -fd']) {
      write('scripts/probe.sh', shellScript([line]));
      const result = preflight(['scripts/probe.sh']);
      expect(result.stdout, line).toContain('discards working-tree state');
      expect(result.status, line).toBe(1);
    }
  });

  test('the argv-array and shell-template spellings are caught', () => {
    // Assembled rather than written out, so this file does not itself read as a
    // restore — the check deliberately cannot tell a quoted command from a run one.
    const g = 'git';
    for (const line of [`execFileSync("${g}", ["checkout", "--", "x"]);`, `Bun.$\`${g} stash\`;`]) {
      write('tests/a.test.ts', `${line}\n`);
      const result = preflight(['tests/a.test.ts']);
      expect(result.stdout, line).toContain('discards working-tree state');
      expect(result.status, line).toBe(1);
    }
  });

  test('git restore without an explicit -- is still a discard', () => {
    write('scripts/probe.sh', shellScript(['git restore src/thing.ts']));

    const result = preflight(['scripts/probe.sh']);

    expect(result.stdout).toContain('discards working-tree state');
    expect(result.status).toBe(1);
  });

  test('a branch switch is not a discard', () => {
    write('scripts/probe.sh', shellScript(['git checkout main']));

    const result = preflight(['scripts/probe.sh']);

    expect(result.stdout).toContain('no git-checkout restores');
    expect(result.status).toBe(0);
  });

  test('the per-file loop idiom passes, unlike a list that can vanish', () => {
    write('scripts/probe.sh', shellScript(['for f in "${FILES[@]}"; do', '\tdprint fmt "$f"', 'done']));

    const result = preflight(['scripts/probe.sh']);

    expect(result.stdout).toContain('no bare dprint invocations');
    expect(result.status).toBe(0);
  });

  test('prose showing a bare dprint is described, not committed', () => {
    // The same text in a shell file must fire, or this proves nothing.
    const lines = ['# note', '', 'Never run:', '', '```bash', 'dprint fmt', '```'];
    write('docs/note.md', `${lines.join('\n')}\n`);
    write('scripts/probe.sh', shellScript(['dprint fmt']));

    expect(preflight(['docs/note.md']).stdout).toContain('no bare dprint invocations');
    expect(preflight(['docs/note.md']).status).toBe(0);
    expect(preflight(['scripts/probe.sh']).stdout).toContain('no guaranteed file list');
    expect(preflight(['scripts/probe.sh']).status).toBe(1);
  });

  test('a test naming an installer but spawning nothing is left alone', () => {
    write('tests/inst.test.ts', ["const script = join(REPO, 'install.sh');", 'export default script;', ''].join('\n'));

    const result = preflight(['tests/inst.test.ts']);

    expect(result.stdout).toContain('no test spawns an installer');
    expect(result.status).toBe(0);
  });

  test('a git command a test only asserts about is not a restore', () => {
    write('tests/a.test.ts', ["expect(runHook(clone, 'git stash push -q -m wip')).not.toContain('deny');", ''].join('\n'));

    const result = preflight(['tests/a.test.ts']);

    expect(result.stdout).toContain('no git-checkout restores');
    expect(result.status).toBe(0);
  });

  test('dprint with an empty or variable file list fails', () => {
    for (const line of ['dprint fmt', 'FILES=""; dprint fmt $FILES', 'dprint fmt "$@"', 'dprint check ${LIST}']) {
      write('scripts/probe.sh', shellScript([line]));
      const result = preflight(['scripts/probe.sh']);
      expect(result.stdout, line).toContain('no guaranteed file list');
      expect(result.status, line).toBe(1);
    }
  });

  test('dprint with a real path is left alone', () => {
    write('scripts/probe.sh', shellScript(['dprint fmt README.md', 'dprint check "$REPO/moon.yml"']));

    const result = preflight(['scripts/probe.sh']);

    expect(result.stdout).toContain('no bare dprint invocations');
    expect(result.status).toBe(0);
  });

  test('an installer spawned with no env option at all is caught', () => {
    write('tests/inst.test.ts', ["spawnSync('bash', [join(REPO, 'install.sh')], { encoding: 'utf-8' });", ''].join('\n'));

    const result = preflight(['tests/inst.test.ts']);

    expect(result.stdout).toContain('writes the real $HOME');
    expect(result.status).toBe(1);
  });

  test('--no-install mentioned only in a comment does not silence the check', () => {
    write(
      'tests/q.test.ts',
      [
        "const r = spawnSync('bun', [s]);",
        "expect(r.stderr).toContain('Cannot find package');",
        '// note: we deliberately do NOT pass --no-install here',
        '',
      ].join('\n'),
    );

    const result = preflight(['tests/q.test.ts']);

    expect(result.stdout).toContain('auto-install live');
    expect(result.status).toBe(1);
  });

  test('a touched path containing a space is still checked', () => {
    write('tests/a b.test.ts', "test.only('x', () => {});\n");

    const result = preflight(['tests/a b.test.ts']);

    expect(result.stdout).toContain('focused or skipped test');
    expect(result.status).toBe(1);
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

    expect(result.stdout).toContain('no guaranteed file list');
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

describe('a sub-checker that cannot run', () => {
  // preflight resolves bash-status-check next to itself, so a stubbed copy of
  // the scripts directory is the only way to make the child fail for real.
  function withChecker(body: string): ReturnType<typeof spawnSync> {
    const bin = join(root, 'scripts');
    mkdirSync(join(bin, 'lib'), { recursive: true });
    cpSync(PREFLIGHT, join(bin, 'preflight'));
    cpSync(join(REPO, 'scripts', 'lib', 'test-verdict.sh'), join(bin, 'lib', 'test-verdict.sh'));
    writeFileSync(join(bin, 'bash-status-check'), body);
    chmodSync(join(bin, 'bash-status-check'), 0o755);

    write('hooks/leak.sh', shellScript(['f() {', '\tdeclared "$1" && printf ok', '}', 'f x']));
    const list = join(root, '.touched');
    writeFileSync(list, 'hooks/leak.sh\n');
    return spawnSync('bash', [join(bin, 'preflight'), '--repo', root, '--paths-from', list], {
      encoding: 'utf-8',
    });
  }

  test('a crashing checker fails the gate instead of reading as clean', () => {
    const result = withChecker(shellScript(['awk "{{{" "$@"']));

    expect(result.stdout).toContain('could not run');
    expect(result.stdout).not.toContain('no conditional-and status leaks');
    expect(result.status).toBe(1);
  });

  test('a checker that exits 1 saying nothing is a fault, not a finding', () => {
    const result = withChecker(shellScript(['exit 1']));

    expect(result.stdout).toContain('could not run');
    expect(result.status).toBe(1);
  });

  test('a checker that cannot be executed fails the gate', () => {
    const result = withChecker(shellScript(['exit 0']));
    chmodSync(join(root, 'scripts', 'bash-status-check'), 0o000);
    const list = join(root, '.touched');
    const denied = spawnSync(
      'bash',
      [join(root, 'scripts', 'preflight'), '--repo', root, '--paths-from', list],
      { encoding: 'utf-8' },
    );
    chmodSync(join(root, 'scripts', 'bash-status-check'), 0o755);

    expect(result.stdout).toContain('no conditional-and status leaks');
    expect(denied.stdout).toContain('could not run');
    expect(denied.status).toBe(1);
  });
});

describe('base resolution', () => {
  test('an unresolvable base fails rather than reporting nothing to check', () => {
    write('a.txt', 'x\n');
    commitBase();

    const result = spawnSync('bash', [PREFLIGHT, '--repo', root, '--base', 'origin/does-not-exist'], {
      encoding: 'utf-8',
    });

    expect(result.stderr).toContain('cannot resolve --base');
    expect(result.stderr).not.toContain('nothing to check');
    expect(result.status).toBe(1);
  });

  test('a resolvable base with no changes still passes', () => {
    write('a.txt', 'x\n');
    commitBase();

    const result = spawnSync('bash', [PREFLIGHT, '--repo', root, '--base', 'HEAD'], {
      encoding: 'utf-8',
    });

    expect(result.stderr).toContain('nothing to check');
    expect(result.status).toBe(0);
  });
});

const UNFORMATTED = '{"a":1,"b":2}\n';

// PATH with the formatter's own directory removed, so "absent" can be probed on
// a machine that has it.
function pathWithoutDprint(): string {
  const found = Bun.which('dprint');
  const entries = (process.env.PATH ?? '').split(':');
  if (found === null) return entries.join(':');
  return entries.filter((entry) => entry !== dirname(found)).join(':');
}

describe('formatting', () => {
  test('an absent dprint is a skip locally but a failure in CI', () => {
    cpSync(join(REPO, 'dprint.json'), join(root, 'dprint.json'));
    write('bad.json', UNFORMATTED);
    const PATH = pathWithoutDprint();

    const local = preflight(['bad.json'], [], { PATH, CI: '' });
    const ci = preflight(['bad.json'], [], { PATH, CI: 'true' });

    expect(local.stdout).toContain('[skip] dprint not installed');
    expect(local.status).toBe(0);
    expect(ci.stdout).toContain('[FAIL] dprint is not installed');
    expect(ci.status).toBe(1);
  });

  test('a dprint that cannot run leaves the file unchecked rather than exonerated', () => {
    cpSync(join(REPO, 'dprint.json'), join(root, 'dprint.json'));
    write('bad.json', UNFORMATTED);

    const broken = preflight(['bad.json'], [], stubOnPath('dprint', '#!/bin/sh\nexit 70\n'));

    expect(broken.stdout).toContain('could not judge formatting drift');
    expect(broken.stdout).not.toContain('no new drift added');
    expect(broken.status).toBe(1);
  });
});

// These need the real formatter: a stub would only test the stub. dprint is a
// repo-wide dependency that CI installs pinned, so its absence there is a
// broken install rather than a machine without it, and must not read as a pass.
const dprintAvailable = Bun.which('dprint') !== null;
const dprintNotice = 'no dprint on PATH — the formatting-drift cases did NOT run. '
  + 'dprint is a repo-wide dependency; CI installs it pinned via .github/actions/install-dprint.';
if (!dprintAvailable) {
  if (process.env.CI) throw new Error(`tests/build/preflight.test.ts: ${dprintNotice}`);
  console.error(`SKIPPED tests/build/preflight.test.ts: ${dprintNotice}`);
}

describe.if(dprintAvailable)('formatting drift', () => {
  const DRIFTED = '{"a":1}\n';
  const MORE_DRIFT = '{"a":1,"b":2,"c":[3,4],"WHOLE_NEW_MESS":true}\n';

  test('drift that predates the change is left alone, but new drift fails', () => {
    fixtureRepo({ 'inherited.json': UNFORMATTED });
    write('added.json', UNFORMATTED);

    const result = preflightAt('HEAD', ['inherited.json', 'added.json']);

    expect(result.stdout).toContain('already unformatted before this change');
    expect(result.stdout).toContain('inherited.json');
    expect(result.stdout).toContain('dprint fmt added.json');
    expect(result.status).toBe(1);
  });

  test('new drift piled onto an already-drifted file still fails', () => {
    fixtureRepo({ 'drifted.json': DRIFTED });
    write('drifted.json', MORE_DRIFT);

    const result = preflightAt('HEAD', ['drifted.json']);

    expect(result.stdout).toContain('dprint fmt drifted.json');
    expect(result.status).toBe(1);
  });

  test('an untouched already-drifted file is still left alone', () => {
    fixtureRepo({ 'drifted.json': DRIFTED });

    const result = preflightAt('HEAD', ['drifted.json']);

    expect(result.stdout).toContain('no new drift added');
    expect(result.status).toBe(0);
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
