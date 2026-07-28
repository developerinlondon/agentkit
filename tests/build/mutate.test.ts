import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MUTATE = join(import.meta.dir, '..', '..', 'scripts', 'mutate');

let root: string;
let target: string;

const SOURCE = ['export const LIMIT = 10;', 'export const NAME = "agentkit";', ''].join('\n');

function mutate(args: string[], testCommand: string): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [MUTATE, '--file', target, ...args, '--test', testCommand], {
    encoding: 'utf-8',
    cwd: root,
  });
}

// A stand-in for a suite: prints bun's markers, and goes red when LIMIT moves.
function suite(redWhen: string): string {
  return [
    `if grep -q '${redWhen}' '${target}'; then`,
    "  printf '\\n 2 pass\\n 1 fail\\n'",
    'else',
    "  printf '\\n 3 pass\\n 0 fail\\n'",
    'fi',
  ].join('\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-mutate-'));
  target = join(root, 'source.ts');
  writeFileSync(target, SOURCE);
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('verdicts', () => {
  test('a mutation the tests notice is CAUGHT, and exits 0', () => {
    const result = mutate(['--replace', 'LIMIT = 10', '--with', 'LIMIT = 99'], suite('LIMIT = 99'));

    expect(result.stderr).toContain('CAUGHT');
    expect(result.stderr).toContain('2 pass / 1 fail');
    expect(result.status).toBe(0);
  });

  test('a mutation no test notices is SURVIVED, and exits 1', () => {
    const result = mutate(['--replace', 'LIMIT = 10', '--with', 'LIMIT = 99'], suite('NEVER_MATCHES'));

    expect(result.stderr).toContain('SURVIVED');
    expect(result.stderr).toContain('no test failed');
    expect(result.status).toBe(1);
  });

  test('a suite that prints no marker yields no verdict rather than a pass', () => {
    const result = mutate(['--replace', 'LIMIT = 10', '--with', 'LIMIT = 99'], 'exit 0');

    expect(result.stderr).toContain('no pass/fail marker');
    expect(result.status).toBe(3);
  });

  test('a pattern that never matched is a harness fault, not a survival', () => {
    const result = mutate(['--replace', 'NOT_PRESENT', '--with', 'x'], suite('LIMIT = 99'));

    expect(result.stderr).toContain('the pattern never matched');
    expect(result.status).toBe(3);
    expect(readFileSync(target, 'utf-8')).toBe(SOURCE);
  });
});

describe('restoration', () => {
  test('the file is byte-identical after a caught mutation', () => {
    mutate(['--replace', 'LIMIT = 10', '--with', 'LIMIT = 99'], suite('LIMIT = 99'));

    expect(readFileSync(target, 'utf-8')).toBe(SOURCE);
  });

  test('the file is byte-identical after a survived mutation', () => {
    mutate(['--replace', 'LIMIT = 10', '--with', 'LIMIT = 99'], suite('NEVER_MATCHES'));

    expect(readFileSync(target, 'utf-8')).toBe(SOURCE);
  });

  test('the file is byte-identical after the test command dies', () => {
    mutate(['--replace', 'LIMIT = 10', '--with', 'LIMIT = 99'], 'kill -9 $$');

    expect(readFileSync(target, 'utf-8')).toBe(SOURCE);
  });

  test('an uncommitted neighbouring edit survives, because git is never used to restore', () => {
    const neighbour = join(root, 'neighbour.ts');
    writeFileSync(neighbour, 'uncommitted work\n');

    mutate(['--replace', 'LIMIT = 10', '--with', 'LIMIT = 99'], suite('LIMIT = 99'));

    expect(readFileSync(neighbour, 'utf-8')).toBe('uncommitted work\n');
  });
});

describe('mutation forms', () => {
  test('--replace is literal, so regex metacharacters are not interpreted', () => {
    writeFileSync(target, 'const re = value.a;\n');
    const result = mutate(['--replace', 'e.a', '--with', 'e.b'], suite('e.b'));

    expect(result.status).toBe(0);
    expect(readFileSync(target, 'utf-8')).toBe('const re = value.a;\n');
  });

  test('--sed expressions apply in order', () => {
    const result = mutate(
      ['--sed', 's/LIMIT = 10/LIMIT = 50/', '--sed', 's/LIMIT = 50/LIMIT = 99/'],
      suite('LIMIT = 99'),
    );

    expect(result.stderr).toContain('CAUGHT');
    expect(result.status).toBe(0);
  });

  test('--replace without --with is a usage error', () => {
    const result = mutate(['--replace', 'LIMIT = 10'], suite('LIMIT = 99'));

    expect(result.stderr).toContain('usage: mutate');
    expect(result.status).toBe(2);
  });

  test('no mutation at all is a usage error', () => {
    const result = spawnSync('bash', [MUTATE, '--file', target, '--test', 'true'], {
      encoding: 'utf-8',
    });

    expect(result.stderr).toContain('usage: mutate');
    expect(result.status).toBe(2);
  });

  test('mutating the running script is refused, because bash reads it lazily', () => {
    const result = spawnSync(
      'bash',
      [MUTATE, '--file', MUTATE, '--replace', 'digest', '--with', 'x', '--test', 'true'],
      { encoding: 'utf-8' },
    );

    expect(result.stderr).toContain('refusing to mutate the running script');
    expect(result.status).toBe(2);
  });

  test('a missing file is refused before anything runs', () => {
    const result = spawnSync(
      'bash',
      [MUTATE, '--file', join(root, 'absent.ts'), '--replace', 'a', '--with', 'b', '--test', 'true'],
      { encoding: 'utf-8' },
    );

    expect(result.stderr).toContain('no such file');
    expect(result.status).toBe(2);
  });
});
