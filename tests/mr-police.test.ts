import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// mr-police must resolve the repo from the COMMAND (an explicit --repo flag or
// a `cd <path>` prefix), not the hook's cwd, and honor an inline
// AGENTKIT_MR_POLICE_MAX. Tests run against a glab shim so nothing talks to a
// real GitLab: the shim answers `api /user` and `mr list`, reporting one open
// MR whenever its arguments mention "busy", and logs every invocation.

const HOOK = join(import.meta.dir, '..', 'hooks', 'claude', 'mr-police.sh');

let root: string;
let shimLog: string;
let repoBusy: string;
let repoFree: string;

function makeRepo(dir: string, originUrl: string): void {
  mkdirSync(dir);
  execSync('git init -q -b main', { cwd: dir, stdio: 'pipe' });
  execSync(`git remote add origin ${originUrl}`, { cwd: dir, stdio: 'pipe' });
}

function runHook(cwd: string, command: string): string {
  const input = JSON.stringify({ tool_input: { command } });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, SHIM_LOG: shimLog };
  delete env.AGENTKIT_MR_POLICE_MAX;
  delete env.GITLAB_HOST;
  const res = spawnSync('bash', [HOOK], { cwd, input, encoding: 'utf-8', env });
  return res.stdout ?? '';
}

function shimCalls(): string {
  try {
    return readFileSync(shimLog, 'utf-8');
  } catch {
    return '';
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-mrpolice-'));
  shimLog = join(root, 'shim.log');
  mkdirSync(join(root, 'bin'));
  const shim = `#!/usr/bin/env bash
echo "\${GITLAB_HOST:-nohost}|$*" >> "$SHIM_LOG"
case "$1 $2" in
  "api /user") echo '{"username":"tester"}' ;;
  "mr list") [[ "$*" == *busy* ]] && echo '!42 open change' ;;
esac
exit 0
`;
  writeFileSync(join(root, 'bin', 'glab'), shim);
  chmodSync(join(root, 'bin', 'glab'), 0o755);
  repoBusy = join(root, 'repo-busy');
  repoFree = join(root, 'repo-free');
  makeRepo(repoBusy, 'git@gitlab.example.com:group/busy.git');
  makeRepo(repoFree, 'git@gitlab.example.com:group/free.git');
});

afterEach(() => {
  rmSync(shimLog, { force: true });
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('mr-police repo resolution', () => {
  test('denies via the cd-targeted repo, passing its origin to glab', () => {
    const out = runHook(root, `cd ${repoBusy} && glab mr create --assignee me --title x`);
    expect(out).toContain('"deny"');
    expect(out).toContain('!42');
    expect(shimCalls()).toContain('--repo git@gitlab.example.com:group/busy.git');
    expect(shimCalls()).toContain('gitlab.example.com|');
  });

  test('allows when the cd-targeted repo has no open MRs, whatever the cwd repo has', () => {
    const out = runHook(repoBusy, `cd ${repoFree} && glab mr create --assignee me --title x`);
    expect(out).not.toContain('"deny"');
    expect(shimCalls()).toContain('--repo git@gitlab.example.com:group/free.git');
  });

  test('an explicit --repo flag wins over the cwd repo', () => {
    const out = runHook(repoBusy, 'glab mr create --repo group/free --assignee me --title x');
    expect(out).not.toContain('"deny"');
    expect(shimCalls()).toContain('mr list --author tester --repo group/free');
  });

  test('falls back to the cwd repo when the command names none', () => {
    const out = runHook(repoBusy, 'glab mr create --assignee me --title x');
    expect(out).toContain('"deny"');
    expect(shimCalls()).toContain('--repo git@gitlab.example.com:group/busy.git');
  });
});

describe('mr-police threshold override', () => {
  test('inline AGENTKIT_MR_POLICE_MAX raises the limit for that command', () => {
    const out = runHook(
      root,
      `cd ${repoBusy} && AGENTKIT_MR_POLICE_MAX=2 glab mr create --assignee me --title x`,
    );
    expect(out).not.toContain('"deny"');
  });

  test('environment AGENTKIT_MR_POLICE_MAX still works', () => {
    const input = JSON.stringify({
      tool_input: { command: `cd ${repoBusy} && glab mr create --assignee me --title x` },
    });
    const res = spawnSync('bash', [HOOK], {
      cwd: root,
      input,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        SHIM_LOG: shimLog,
        AGENTKIT_MR_POLICE_MAX: '2',
      },
    });
    expect(res.stdout ?? '').not.toContain('"deny"');
  });
});

describe('mr-police assignee rule', () => {
  test('denies an unassigned MR before ever calling glab', () => {
    const out = runHook(root, `cd ${repoFree} && glab mr create --title x`);
    expect(out).toContain('"deny"');
    expect(out).toContain('assignee');
    expect(shimCalls()).toBe('');
  });
});
