import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..');
const SUPERVISOR = join(ROOT, 'hooks', 'claude', 'fail-closed-hook.sh');
const roots: string[] = [];

function child(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-hook-supervisor-'));
  roots.push(root);
  const path = join(root, 'child.sh');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function run(path: string, deadline = '1', target?: string) {
  return spawnSync('bash', [SUPERVISOR, deadline, path], {
    env: target ? { ...process.env, AGENTKIT_HOOK_TARGET: target } : process.env,
    input: '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 12"}}',
    encoding: 'utf-8',
    timeout: 4_000,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('fail-closed hook supervisor', () => {
  test('relays a fast silent pass and a valid denial unchanged', () => {
    const pass = run(child('cat >/dev/null'));
    expect(pass.status).toBe(0);
    expect(pass.stdout).toBe('');

    const denial = '{"decision":"deny","reason":"fixture"}';
    const denied = run(child(`cat >/dev/null; printf '%s\\n' '${denial}'`));
    expect(denied.status).toBe(0);
    expect(denied.stdout.trim()).toBe(denial);
  });

  test('normalizes a relayed denial for Codex without dropping its nested denial', () => {
    const denial = {
      decision: 'deny',
      reason: 'fixture',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'fixture',
      },
    };
    const result = run(
      child(`cat >/dev/null; printf '%s\\n' '${JSON.stringify(denial)}'`),
      '1',
      'codex',
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ...denial, decision: 'block' });
  });

  test('emits Codex denials from shell and child-process fallback paths', () => {
    const shellFallback = spawnSync('bash', [SUPERVISOR], {
      encoding: 'utf-8',
      env: { ...process.env, AGENTKIT_HOOK_TARGET: 'codex' },
    });
    const childFallback = run(child('cat >/dev/null; echo not-json'), '1', 'codex');

    for (const result of [shellFallback, childFallback]) {
      expect(result.status).toBe(0);
      const denial = JSON.parse(result.stdout);
      expect(denial.decision).toBe('block');
      expect(denial.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(denial.reason).toContain('fail-closed hook supervisor');
    }
  });

  test('turns timeout, crash, and malformed output into explicit denials', () => {
    const cases = [
      child('cat >/dev/null; sleep 5'),
      child('cat >/dev/null; exit 7'),
      child('cat >/dev/null; echo not-json'),
    ];
    for (const path of cases) {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
      expect(result.stdout).toContain('fail-closed hook supervisor');
    }
  });

  test('does not wait on a detached descendant that inherited the output pipe', () => {
    const started = performance.now();
    const result = run(
      child(
        `cat >/dev/null
python3 -c 'import os,time; os.setsid(); time.sleep(5)' &
sleep 5`,
      ),
    );
    const elapsed = performance.now() - started;

    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    expect(elapsed).toBeLessThan(3_500);
  });

  test('keeps the child deadline below both registered host deadlines', () => {
    const source = JSON.parse(readFileSync(join(ROOT, 'hooks', 'claude', 'settings.json'), 'utf-8'));
    const plugin = JSON.parse(
      readFileSync(join(ROOT, 'plugins-cc', 'agentkit', 'hooks', 'hooks.json'), 'utf-8'),
    );
    for (const settings of [source, plugin]) {
      const entries = settings.hooks.PreToolUse.flatMap((group: any) => group.hooks);
      const reviewEntries = entries.filter((entry: any) => entry.command.includes('review-police.sh'));
      expect(reviewEntries).toHaveLength(2);
      for (const entry of reviewEntries) {
        expect(entry.command).toContain('fail-closed-hook.sh 45');
        expect(entry.timeout).toBe(60);
      }
    }
  });
});
