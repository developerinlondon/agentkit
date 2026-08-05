import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import tastePolice from '../../plugins/taste-police.ts';

const repoRoot = join(import.meta.dir, '..', '..');
const scripts = join(repoRoot, 'skills', 'taste', 'scripts');
const hook = join(repoRoot, 'hooks', 'claude', 'taste-police.sh');
const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    rmSync(sandboxes.pop() as string, { recursive: true, force: true });
  }
});

function sandbox(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-taste-lane-'));
  sandboxes.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

const RELEASE_TIER = `---
name: release-tier
scope: project
strength: require
enforce: block
rule:
  kind: command
  match: 'git tag .*\\bv[0-9]+\\.[0-9]+\\.0\\b'
  remedy: Cut a patch tag, or record the owner's agreement in the release PR first.
  override: AGENTKIT_RELEASE_TIER
provenance: 2026-08-05 · session correction
---

Cut patch releases by default.

Why: "publish this" authorizes a release, never the tier.

How to apply: propose the patch version in the release PR.
`;

const TAG_MINOR = 'git tag v0.8.0';
const PROJECT = { '.agentkit/tastes/release-tier.md': RELEASE_TIER };

interface HookRun {
  stdout: string;
  status: number | null;
}

function runHook(
  command: string,
  cwd: string,
  env: Record<string, string> = {},
  script = hook,
): HookRun {
  const home = env.HOME ?? sandbox();
  const result = spawnSync('bash', [script], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      cwd,
      session_id: 'taste-lane',
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTKIT_TASTE_SCRIPTS: scripts,
      ...env,
    },
  });
  return { stdout: result.stdout ?? '', status: result.status };
}

function parse(stdout: string): Record<string, any> {
  try {
    return JSON.parse(stdout) as Record<string, any>;
  } catch {
    return {};
  }
}

function isDeny(stdout: string): boolean {
  const json = parse(stdout);
  return json.decision === 'deny' && json.hookSpecificOutput?.permissionDecision === 'deny';
}

describe('the Claude hook lane refuses from the same data', () => {
  test('a matching command denies in both payload dialects', () => {
    const cwd = sandbox(PROJECT);
    const denial = runHook(TAG_MINOR, cwd);

    expect(isDeny(denial.stdout)).toBe(true);
    expect(denial.status).toBe(0);
    const json = parse(denial.stdout);
    expect(json.reason).toContain('BLOCKED by taste release-tier');
    expect(json.reason).toContain('Cut a patch tag');
    expect(json.reason).toContain('AGENTKIT_RELEASE_TIER');
    expect(json.hookSpecificOutput.permissionDecisionReason).toBe(json.reason);
  });

  test('a command the rule does not match is not answered at all', () => {
    const cwd = sandbox(PROJECT);
    const allowed = runHook('git tag v0.7.5', cwd);

    expect(allowed.stdout.trim()).toBe('');
    expect(allowed.status).toBe(0);
  });

  test('the inline override lets it through with a notice, not a refusal', () => {
    const cwd = sandbox(PROJECT);
    const run = runHook(`AGENTKIT_RELEASE_TIER=minor ${TAG_MINOR}`, cwd);

    expect(isDeny(run.stdout)).toBe(false);
    expect(parse(run.stdout).hookSpecificOutput?.additionalContext).toContain(
      'AGENTKIT_RELEASE_TIER',
    );
  });

  test('an override value that reads as off still refuses', () => {
    const cwd = sandbox(PROJECT);
    const run = runHook(`AGENTKIT_RELEASE_TIER=0 ${TAG_MINOR}`, cwd);

    expect(isDeny(run.stdout)).toBe(true);
    expect(parse(run.stdout).reason).toContain('does not read as a deliberate override');
  });

  test('taste.enabled: false makes the hook inert', () => {
    const cwd = sandbox({ ...PROJECT, '.agentkit/config.yaml': 'taste:\n  enabled: false\n' });
    expect(runHook(TAG_MINOR, cwd).stdout.trim()).toBe('');
  });

  test('a non-Bash tool is none of its business', () => {
    const cwd = sandbox(PROJECT);
    const result = spawnSync('bash', [hook], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/x', content: TAG_MINOR },
        cwd,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: sandbox(), AGENTKIT_TASTE_SCRIPTS: scripts },
    });
    expect(result.stdout?.trim()).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('the deadline reaches through the lane, not just the evaluator', () => {
  const EVIL_TASTE = `---
name: evil
scope: project
strength: require
enforce: block
rule:
  kind: command
  match: '(a+)+$'
  remedy: Never fires.
  override: AGENTKIT_EVIL
provenance: 2026-08-05 · owner
---

A pattern that backtracks catastrophically.

Why: it is the shape the evaluator has to survive.

How to apply: it never matches anything in time.
`;

  // The hook's own `timeout 8` would also stop this, so the assertion is that it
  // comes back FAST — under the evaluator's deadline plus a runtime start,
  // nowhere near the outer ceiling. That is what proves the inner bound ran.
  test('a pathological pattern returns in well under the outer timeout', () => {
    const cwd = sandbox({ '.agentkit/tastes/evil.md': EVIL_TASTE });

    const started = performance.now();
    const run = runHook(`${'a'.repeat(46)}!`, cwd);
    const elapsed = performance.now() - started;

    expect(isDeny(run.stdout)).toBe(false);
    expect(parse(run.stdout).systemMessage).toContain('evil');
    expect(elapsed).toBeLessThan(4000);
  });
});

describe('an unrunnable hook reports UNCHECKED rather than allowing quietly', () => {
  // A copy with no skills/ beside it: the only way to exercise the lane's own
  // fallbacks, since the repository checkout always resolves the evaluator.
  function detachedHook(): string {
    const root = sandbox();
    mkdirSync(join(root, 'hooks', 'lib'), { recursive: true });
    cpSync(hook, join(root, 'hooks', 'taste-police.sh'));
    cpSync(join(repoRoot, 'hooks', 'claude', 'lib'), join(root, 'hooks', 'lib'), {
      recursive: true,
    });
    chmodSync(join(root, 'hooks', 'taste-police.sh'), 0o755);
    return join(root, 'hooks', 'taste-police.sh');
  }

  test('a missing evaluator advises where tastes exist', () => {
    const cwd = sandbox(PROJECT);
    const run = runHook(TAG_MINOR, cwd, { AGENTKIT_TASTE_SCRIPTS: '/nonexistent' }, detachedHook());

    expect(isDeny(run.stdout)).toBe(false);
    expect(parse(run.stdout).systemMessage).toContain('UNCHECKED');
  });

  test('a missing evaluator is silent where there are no tastes', () => {
    const run = runHook(TAG_MINOR, sandbox(), {
      AGENTKIT_TASTE_SCRIPTS: '/nonexistent',
    }, detachedHook());

    expect(run.stdout.trim()).toBe('');
  });

  test('a missing bun advises rather than refusing every command', () => {
    const cwd = sandbox(PROJECT);
    const run = runHook(TAG_MINOR, cwd, { BUN_BIN: '/nonexistent/bun' });

    expect(isDeny(run.stdout)).toBe(false);
    expect(parse(run.stdout).systemMessage).toContain('UNCHECKED');
  });
});

describe('the OpenCode plugin lane', () => {
  const realHome = process.env.HOME;
  const realScripts = process.env.AGENTKIT_TASTE_SCRIPTS;
  process.env.AGENTKIT_TASTE_SCRIPTS = scripts;

  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realScripts === undefined) delete process.env.AGENTKIT_TASTE_SCRIPTS;
    else process.env.AGENTKIT_TASTE_SCRIPTS = realScripts;
  });

  function context(cwd: string) {
    process.env.HOME = sandbox();
    return {
      client: {},
      project: {},
      directory: cwd,
      worktree: cwd,
      serverUrl: new URL('http://localhost'),
      $: {},
      // deno-lint-ignore no-explicit-any
    } as any;
  }

  function call(cwd: string, command: string) {
    return tastePolice(context(cwd)).then((hooks) =>
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 'test', callID: 'test' },
        { args: { command } },
      )
    );
  }

  test('refuses a matching command with the taste\'s own remedy', async () => {
    const cwd = sandbox(PROJECT);
    await expect(call(cwd, TAG_MINOR)).rejects.toThrow('BLOCKED by taste release-tier');
  });

  test('passes a command no rule matches', async () => {
    const cwd = sandbox(PROJECT);
    await call(cwd, 'git tag v0.7.5');
  });

  test('the inline override lets the command through', async () => {
    const cwd = sandbox(PROJECT);
    await call(cwd, `AGENTKIT_RELEASE_TIER=minor ${TAG_MINOR}`);
  });

  test('an off-reading override value still refuses', async () => {
    const cwd = sandbox(PROJECT);
    await expect(call(cwd, `AGENTKIT_RELEASE_TIER=off ${TAG_MINOR}`)).rejects.toThrow(
      'does not read as a deliberate override',
    );
  });

  test('a non-bash tool is untouched', async () => {
    const cwd = sandbox(PROJECT);
    const hooks = await tastePolice(context(cwd));
    await hooks['tool.execute.before']!(
      { tool: 'write', sessionID: 'test', callID: 'test' },
      { args: { command: TAG_MINOR } },
    );
  });
});
