import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repoRoot = dirname(dirname(import.meta.dir));
const waitFor = join(repoRoot, 'tools', 'wait-for');

let work: string;
let stubBin: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'agentkit-wait-for-'));
  stubBin = join(work, 'bin');
  mkdirSync(stubBin, { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function stub(name: string, body: string): void {
  const path = join(stubBin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(args: string[]) {
  return spawnSync('bash', [waitFor, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ''}` },
  });
}

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'wait-for test',
  GIT_AUTHOR_EMAIL: 'wait-for@test.invalid',
  GIT_COMMITTER_NAME: 'wait-for test',
  GIT_COMMITTER_EMAIL: 'wait-for@test.invalid',
};

function git(...args: string[]) {
  const result = spawnSync('git', args, { encoding: 'utf-8', env: gitIdentity });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('wait-for exits on the predicate', () => {
  test('file-match succeeds as soon as the file matches', () => {
    const path = join(work, 'record.json');
    writeFileSync(path, '{"status": "done"}\n');
    const result = run(['--cap', '5', '--every', '1', '--file-match', path, '"status": *"done"']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('file-match');
    expect(result.stdout).toContain(path);
  });

  test('a ref that moves ends the poll, and one that sits still does not', () => {
    const repo = join(work, 'repo');
    git('init', '-q', repo);
    git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'one');
    const before = run(['--cap', '2', '--every', '1', '--sha', repo, 'HEAD']);
    expect(before.status).toBe(3);

    // The branch does not exist at start, so the baseline is empty and its
    // creation is the move the poll is waiting for.
    const moved = spawnSync('bash', [
      '-c',
      `( sleep 1; git -C "${repo}" branch shipped ) >/dev/null 2>&1 & exec bash "${waitFor}" --cap 20 --every 1 --sha "${repo}" shipped`,
    ], { encoding: 'utf-8' });
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain('moved');
  });

  test('pr-checks waits out gh exit 8 and stops on a verdict', () => {
    const counter = join(work, 'calls');
    stub('gh', `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${counter}"; [ "$n" -ge 3 ] && exit 1; exit 8`);
    const result = run(['--cap', '20', '--every', '1', '--pr-checks', 'owner/repo', '437']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('concluded (gh exit 1)');
  });

  test('pr-checks that stays pending reaches the cap', () => {
    stub('gh', 'exit 8');
    const result = run(['--cap', '2', '--every', '1', '--pr-checks', 'owner/repo', '437']);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('cap 2s reached');
  });

  test('url matches the status it was told to expect', () => {
    stub('curl', 'echo -n 503');
    expect(run(['--cap', '2', '--every', '1', '--url', 'https://x.test']).status).toBe(3);
    expect(run(['--cap', '2', '--every', '1', '--url', 'https://x.test', '--status', '503']).status).toBe(0);
  });
});

describe('wait-for refuses what it cannot poll', () => {
  test('no predicate, two predicates, and a non-numeric cap are usage errors', () => {
    expect(run(['--cap', '10', '--every', '1']).status).toBe(2);
    expect(run(['--cap', '10', '--every', '1', '--url', 'https://x.test', '--file-match', '/tmp/x', 'y']).status)
      .toBe(2);
    expect(run(['--cap', 'soon', '--every', '1', '--file-match', '/tmp/x', 'y']).status).toBe(2);
    expect(run(['--cap', '0', '--every', '1', '--file-match', '/tmp/x', 'y']).status).toBe(2);
  });

  test('--help explains itself and exits clean', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('--pr-checks');
  });
});
