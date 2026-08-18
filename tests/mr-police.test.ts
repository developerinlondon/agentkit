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

// The command-text gates below run BEFORE the glab lookups, so they need no
// shim — a PATH without a forge CLI proves they fire on their own.
function runTextGate(command: string, configYaml?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'agentkit-mrcfg-'));
  try {
    if (configYaml) {
      mkdirSync(join(home, 'agentkit'), { recursive: true });
      writeFileSync(join(home, 'agentkit', 'config.yaml'), configYaml);
    }
    const res = spawnSync('bash', [HOOK], {
      cwd: root,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf-8',
      env: { PATH: '/usr/bin:/bin', HOME: root, CLAUDE_PROJECT_DIR: root, XDG_CONFIG_HOME: home },
    });
    return res.stdout ?? '';
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

function textGateDenied(command: string, configYaml?: string): boolean {
  return runTextGate(command, configYaml).includes('"deny"');
}

describe('mr-police: the REST path is the same creation as the CLI', () => {
  test('a REST merge request with no assignee is refused', () => {
    const out = runTextGate(
      'glab api --method POST "projects/g%2Fr/merge_requests" -f source_branch=fix -f title=x',
    );
    expect(out).toContain('"deny"');
    expect(out).toContain('REST API with no assignee');
  });

  test('a REST merge request naming an assignee passes', () => {
    expect(
      textGateDenied('glab api --method POST "projects/g%2Fr/merge_requests" -f title=x -f assignee_id=42'),
    ).toBe(false);
  });

  test('a GitHub pull request created over the API carries the same rule', () => {
    expect(textGateDenied('gh api --method POST /repos/o/r/pulls -f title=x -f base=main')).toBe(true);
  });

  test('reading merge requests is not a creation', () => {
    expect(textGateDenied('glab api "projects/g%2Fr/merge_requests?state=opened"')).toBe(false);
  });

  test('a merge_requests URL quoted in a body is not a creation', () => {
    expect(
      textGateDenied('glab api --method POST "projects/g%2Fr/issues" -f description="see /merge_requests"'),
    ).toBe(false);
  });
});

describe('mr-police: issue-first is the project’s call', () => {
  const noRef = 'glab mr create --assignee sam --title "fix the poller" --description "widens the filter"';

  test('nothing is required by default', () => {
    expect(textGateDenied(noRef)).toBe(false);
  });

  test('with the requirement on, an MR naming no issue is refused', () => {
    expect(textGateDenied(noRef, 'mr-police:\n  require-issue-reference: true\n')).toBe(true);
  });

  test('a reference satisfies it', () => {
    expect(
      textGateDenied(
        'glab mr create --assignee sam --title x --description "Addresses #42"',
        'mr-police:\n  require-issue-reference: true\n',
      ),
    ).toBe(false);
  });
});

describe('mr-police: closing keywords decide completion for someone else', () => {
  const closing = 'glab mr create --assignee sam --title x --description "Closes #42"';

  test('allowed by default, because many projects want the auto-close', () => {
    expect(textGateDenied(closing)).toBe(false);
  });

  test('refused where the project has turned it off', () => {
    const out = runTextGate(closing, 'mr-police:\n  forbid-closing-keywords: true\n');
    expect(out).toContain('"deny"');
    expect(out).toContain('closing keyword');
  });

  test('the word alone, with no issue number beside it, is prose and passes', () => {
    expect(
      textGateDenied(
        'glab mr create --assignee sam --title x --description "this fixes the poller"',
        'mr-police:\n  forbid-closing-keywords: true\n',
      ),
    ).toBe(false);
  });
});
