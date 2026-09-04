import { test as bunTest } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { HOOK, SUPERVISOR } from './constants';
import { bin, home, repo } from './fixture';

const HOOK_TIMEOUT_MS = 15_000;

// review-police.sh exits 0 on every path — allow (empty stdout), deny (a JSON
// decision), even its own missing-jq fallback. A non-zero exit, a kill signal,
// or a spawn error (which covers a timeout) therefore never means "allow": it
// means the gate never actually answered, which an empty string cannot be
// told apart from otherwise. Returns null when the process answered normally.
function hookDidNotAnswer(res: ReturnType<typeof spawnSync>): string | null {
  if (!res.error && res.status === 0) return null;
  const how = res.error
    ? `spawn failed: ${res.error.message}`
    : `exited ${res.status ?? 'null'}${res.signal ? ` (signal ${res.signal})` : ''}`;
  const stderrTail = (res.stderr ?? '').toString().trim().split('\n').slice(-10).join('\n');
  return `review-police.sh did not answer — ${how}${stderrTail ? `\nstderr:\n${stderrTail}` : ''}`;
}

interface HookDiagnostics {
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
}

// Overwritten on every runHook() call, read back only if the test that made
// the call goes on to fail — see the test() wrapper below.
let lastHookCall: HookDiagnostics | null = null;

export function runHook(
  command: string,
  opts: {
    tool?: string;
    cwd?: string;
    supervised?: boolean;
    toolWorkdir?: string;
    toolWorkdirField?: 'workdir' | 'cwd';
    camelToolInput?: boolean;
    payloadCwd?: string;
    hookPath?: string;
  } = {},
): string {
  const toolInput =
    opts.tool && opts.tool !== 'Bash'
      ? { pull_number: 12 }
      : {
          command,
          ...(opts.toolWorkdir === undefined
            ? {}
            : { [opts.toolWorkdirField ?? 'workdir']: opts.toolWorkdir }),
        };
  const input = JSON.stringify({
    ...(opts.camelToolInput
      ? { toolName: opts.tool ?? 'Bash', toolInput, sessionId: 'test-session' }
      : { tool_name: opts.tool ?? 'Bash', tool_input: toolInput, session_id: 'test-session' }),
    ...(opts.payloadCwd === undefined ? {} : { cwd: opts.payloadCwd }),
  });
  const hookPath = opts.hookPath ?? HOOK;
  const args = opts.supervised ? [SUPERVISOR, '5', hookPath] : [hookPath];
  const startedAt = Date.now();
  const res = spawnSync('bash', args, {
    cwd: opts.cwd ?? repo,
    input,
    encoding: 'utf-8',
    timeout: HOOK_TIMEOUT_MS,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home },
  });
  lastHookCall = {
    stdin: input,
    stdout: res.stdout ?? '',
    stderr: (res.stderr ?? '').toString(),
    exitCode: res.status,
    signal: res.signal,
    elapsedMs: Date.now() - startedAt,
  };
  const failure = hookDidNotAnswer(res);
  if (failure) throw new Error(failure);
  return res.stdout ?? '';
}

// Read with the same PATH/HOME runHook() gave the hook, so a fallthrough to a
// real system glab/gh instead of the fixture stub (a PATH-resolution race)
// shows up here rather than staying invisible.
function forgeVersionAsSeenByHook(cli: 'glab' | 'gh'): string {
  const res = spawnSync(cli, ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home },
  });
  if (res.error) return `<spawn failed: ${res.error.message}>`;
  const out = (res.stdout || res.stderr || '').toString().trim();
  return out || `<empty output, exit ${res.status ?? 'null'}>`;
}

function dumpLastHookCall(c: HookDiagnostics): string {
  return [
    '----- runHook diagnostics (most recent call in this test) -----',
    `stdin sent to the hook:\n${c.stdin}`,
    `exit: ${c.exitCode ?? 'null'}${c.signal ? ` (signal ${c.signal})` : ''}, elapsed: ${c.elapsedMs}ms`,
    `glab --version as seen by the hook: ${forgeVersionAsSeenByHook('glab')}`,
    `gh --version as seen by the hook: ${forgeVersionAsSeenByHook('gh')}`,
    `hook stdout:\n${c.stdout}`,
    `hook stderr:\n${c.stderr}`,
    '-----------------------------------------------------------------',
  ].join('\n');
}

// The part of the test() wrapper below that can be exercised directly, without
// registering a real (deliberately failing) case with the test framework —
// see "review-police test probe: failure diagnostics" for the proof.
export function runProbedTest(fn: () => void): void {
  lastHookCall = null;
  try {
    fn();
  } catch (err) {
    // No runHook() call happened in this test: nothing to add, and no
    // "no call recorded" filler either — the block is either useful or absent.
    if (!lastHookCall) throw err;
    const diagnostics = dumpLastHookCall(lastHookCall);
    if (err instanceof Error) {
      err.message = `${err.message}\n\n${diagnostics}`;
      throw err;
    }
    throw new Error(`${String(err)}\n\n${diagnostics}`);
  }
}

// Every test file imports this instead of bun:test's test(), so a failing
// assertion anywhere carries the last runHook() call's full diagnostics in
// its message without touching each test body. Passing tests are unaffected.
export function test(name: string, fn: () => void): void {
  bunTest(name, () => runProbedTest(fn));
}
