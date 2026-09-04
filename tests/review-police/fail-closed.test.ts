import { describe, expect } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MERGE, passing } from './commands';
import { HOOK } from './constants';
import { bin, home, installFixture, record, repo } from './fixture';
import { runHook, test } from './probe';

installFixture();

describe('review-police: a silent hook is not read as an allow', () => {
  // A hook that exits non-zero with empty stdout used to read as an ALLOW
  // row's expected `''` — the gate never actually answered, and the probe
  // could not tell the difference.
  test('a stub that exits non-zero saying nothing is reported, not swallowed', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'review-police-stub-'));
    const stub = join(stubDir, 'silent-hook.sh');
    writeFileSync(stub, '#!/usr/bin/env bash\nexit 7\n');
    chmodSync(stub, 0o755);
    try {
      expect(() => runHook(MERGE, { hookPath: stub })).toThrow('did not answer');
      expect(() => runHook(MERGE, { hookPath: stub })).toThrow('exited 7');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

describe('review-police: the hook itself cannot fail open', () => {
  // Every abort path is a fail-open: a hook that dies prints no decision and
  // the harness allows the tool call. These two were reachable from the
  // environment alone.
  function runBare(env: Record<string, string | undefined>): ReturnType<typeof spawnSync> {
    return spawnSync('bash', [HOOK], {
      cwd: repo,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: MERGE },
        session_id: 'test-session',
      }),
      encoding: 'utf-8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...env },
    });
  }

  test('an unset HOME does not abort the gate', () => {
    record(passing);
    // AUDIT="${HOME}/..." tripped `set -u`, exiting 1 with no decision.
    const res = runBare({ HOME: undefined });
    expect(res.stderr).not.toContain('unbound variable');
    expect(res.status).toBe(0);
  });

  test('writes portable UTC audit timestamps with BSD or GNU date', () => {
    const audit = join(home, '.agentkit', 'review-audit.log');
    rmSync(audit, { force: true });
    record(passing);

    const res = runBare({});

    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toBe('');
    expect(readFileSync(audit, 'utf-8')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\tPASS\t.*\tgate_seconds=\d+$/m,
    );
  });

  test('a missing jq denies rather than dying', () => {
    record(passing);
    const stub = mkdtempSync(join(tmpdir(), 'nojq-'));
    // A PATH with no jq: the hook used to exit 127 on its first parse.
    // bash is invoked by ABSOLUTE path — an empty PATH would otherwise fail to
    // locate bash itself, and the spawn error would masquerade as the hook
    // staying silent (i.e. the test would "pass" for the wrong reason).
    const bash = execSync('command -v bash', { encoding: 'utf-8' }).trim();
    const res = spawnSync(bash, [HOOK], {
      cwd: repo,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: MERGE },
        session_id: 'test-session',
      }),
      encoding: 'utf-8',
      env: { PATH: stub, HOME: home },
    });
    expect(res.stdout).toContain('"deny"');
    expect(res.stdout).toContain('jq');
    rmSync(stub, { force: true, recursive: true });
  });
});
