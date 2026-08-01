import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, makeSandbox, repoRoot, sandboxEnv, type Sandbox, toolTimeoutMs, writeExecutable } from './fixture';

const sourceHook = join(repoRoot, 'hooks', 'claude', 'plan-police.sh');
const sourceLib = join(repoRoot, 'hooks', 'claude', 'lib', 'hook-input.sh');
const sourceGate = join(repoRoot, 'tools', 'plan-gate');

let box: Sandbox;
let repo: string;
let plan: string;

/**
 * install.sh copies hooks into a flat directory beside tools/, which is one
 * level shallower than the source tree. Exercising the source layout alone
 * would never load the hook the way a user runs it.
 */
function deployedHook(withGate = true): string {
  const root = join(box.root, 'deployed');
  mkdirSync(join(root, 'hooks', 'lib'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  const hook = join(root, 'hooks', 'plan-police.sh');
  writeExecutable(hook, readFileSync(sourceHook, 'utf8'));
  copyFileSync(sourceLib, join(root, 'hooks', 'lib', 'hook-input.sh'));
  if (withGate) writeExecutable(join(root, 'tools', 'plan-gate'), readFileSync(sourceGate, 'utf8'));
  return hook;
}

function ask(hook: string, payload: unknown, overrides: Record<string, string> = {}) {
  const result = spawnSync(hook, [], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    cwd: repo,
    env: sandboxEnv(box, overrides),
    timeout: toolTimeoutMs,
  });
  expect(result.status).toBe(0);
  const decision = result.stdout.trim()
    ? (JSON.parse(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string }; reason?: string })
    : null;
  return {
    verdict: decision?.hookSpecificOutput?.permissionDecision ?? (decision ? 'advise' : 'allow'),
    reason: decision?.reason ?? result.stdout,
  };
}

// An em dash in the title is deliberate: jq's string `index` counts bytes while
// slicing counts codepoints, so a naive reconstruction silently corrupts the
// file from the first multibyte character onward.
const PLAN_BODY = [
  '# Plan 057 — device exec',
  '',
  '**Status**: In progress',
  '',
  '## Known gaps',
  '',
  '- exec_mode/exec_allow have no UI — highest-value remaining item',
  '- approval timeout, tracked in #311',
  '',
].join('\n');

beforeEach(() => {
  box = makeSandbox('plan-police-');
  repo = join(box.root, 'repo');
  mkdirSync(join(repo, 'plans'), { recursive: true });
  git(repo, box, 'init', '-q', '-b', 'main');
  plan = join(repo, 'plans', '057.md');
  writeFileSync(plan, PLAN_BODY);
});

afterEach(() => {
  rmSync(box.root, { recursive: true, force: true });
});

const markDone = {
  tool_name: 'Edit',
  tool_input: { file_path: '', old_string: '**Status**: In progress', new_string: '**Status**: Done' },
};

function edit(overrides: Record<string, unknown> = {}) {
  return { ...markDone, tool_input: { ...markDone.tool_input, file_path: plan, ...overrides } };
}

describe('the gate', () => {
  test('an edit that marks a plan done while a gap is untracked is refused', () => {
    const { verdict, reason } = ask(deployedHook(), edit());
    expect(verdict).toBe('deny');
    expect(reason).toContain('exec_mode/exec_allow have no UI');
  });

  test('the refusal names the gap but not the ones already tracked', () => {
    const { reason } = ask(deployedHook(), edit());
    expect(reason).not.toContain('approval timeout');
  });

  test('every reference form the refusal offers actually unblocks the edit', () => {
    const { reason } = ask(deployedHook(), edit());
    const offered = [...reason.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .filter((form) => /\d/.test(form) && !form.startsWith('- ['));

    expect(offered.length).toBeGreaterThan(0);
    for (const form of offered) {
      writeFileSync(plan, `# P — x\n\n**Status**: In progress\n\n## Known gaps\n\n- a gap, see ${form}\n`);
      expect(ask(deployedHook(), edit()).verdict, `${form} was offered as a fix`).toBe('allow');
    }
  });

  test('an edit that does not claim done is left alone', () => {
    const { verdict } = ask(deployedHook(), edit({ old_string: 'device exec', new_string: 'device execution' }));
    expect(verdict).toBe('allow');
  });

  test('a plan whose gaps are all closed or tracked may be marked done', () => {
    writeFileSync(plan, '# P — x\n\n**Status**: In progress\n\n## Known gaps\n\n- [x] a\n- b #12\n- ~~c~~\n');
    expect(ask(deployedHook(), edit()).verdict).toBe('allow');
  });

  test('an edit that closes the gap in the same breath is allowed', () => {
    const payload = {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: plan,
        edits: [
          { old_string: 'have no UI — highest-value remaining item', new_string: 'have no UI, filed as #999' },
          { old_string: '**Status**: In progress', new_string: '**Status**: Done' },
        ],
      },
    };
    expect(ask(deployedHook(), payload).verdict).toBe('allow');
  });

  test('writing a whole new plan that claims done with an open gap is refused', () => {
    const payload = {
      tool_name: 'Write',
      tool_input: {
        file_path: join(repo, 'plans', 'new.md'),
        content: '# New — thing\n\nStatus: Shipped\n\n## Known gaps\n\n- nothing tracks the retry path\n',
      },
    };
    expect(ask(deployedHook(), payload).verdict).toBe('deny');
  });

  test('the reconstruction survives multibyte characters earlier in the file', () => {
    const { reason } = ask(deployedHook(), edit());
    expect(reason).toContain('exec_mode/exec_allow have no UI — highest-value remaining item');
    expect(reason).not.toContain('****');
  });

  test('an old_string full of regex metacharacters is treated as data', () => {
    writeFileSync(plan, '# P\n\nstate [x] (a|b) *: pending\n\n## Known gaps\n\n- untracked thing\n');
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: plan, old_string: 'state [x] (a|b) *: pending', new_string: 'Status: Done' },
    };
    expect(ask(deployedHook(), payload).verdict).toBe('deny');
  });
});

describe('paths reached through a symlink', () => {
  // macOS reaches every temporary directory via /var -> /private/var, so git
  // reports one form and the harness passes the other. A path that stops
  // looking like a plan fails OPEN and in silence, which is the one direction
  // this gate must never fail in. Reproduced here on every platform.
  test('a plan under a symlinked repository path is still gated', () => {
    const link = join(box.root, 'link-to-repo');
    symlinkSync(repo, link);
    const through = join(link, 'plans', '057.md');

    const matched = spawnSync(join(repoRoot, 'tools', 'plan-gate'), ['--matches', through], {
      encoding: 'utf8',
      cwd: repo,
      env: sandboxEnv(box),
      timeout: toolTimeoutMs,
    });
    expect(matched.status, 'the symlinked path was not recognised as a plan').toBe(0);

    const { verdict } = ask(deployedHook(), edit({ file_path: through }));
    expect(verdict).toBe('deny');
  });
});

describe('what the gate leaves alone', () => {
  test('a markdown file outside the plan paths', () => {
    const readme = join(repo, 'README.md');
    writeFileSync(readme, PLAN_BODY);
    expect(ask(deployedHook(), edit({ file_path: readme })).verdict).toBe('allow');
  });

  test('a non-markdown file', () => {
    const other = join(repo, 'plans', 'notes.txt');
    writeFileSync(other, PLAN_BODY);
    expect(ask(deployedHook(), edit({ file_path: other })).verdict).toBe('allow');
  });

  test('a tool that is not a file write', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'echo hi' } };
    expect(ask(deployedHook(), payload).verdict).toBe('allow');
  });

  test('the documented kill switch', () => {
    expect(ask(deployedHook(), edit(), { AGENTKIT_SKIP_HOOKS: 'plan-police' }).verdict).toBe('allow');
    expect(ask(deployedHook(), edit(), { AGENTKIT_SKIP_HOOKS: 'all' }).verdict).toBe('allow');
  });

  test('an unrelated hook name in the kill switch does not disarm it', () => {
    expect(ask(deployedHook(), edit(), { AGENTKIT_SKIP_HOOKS: 'coding-police' }).verdict).toBe('deny');
  });
});

describe('when the checker is missing', () => {
  test('a plan edit says the gaps went unchecked rather than passing in silence', () => {
    const { verdict, reason } = ask(deployedHook(false), edit());
    expect(verdict).toBe('advise');
    expect(reason).toContain('NOT checked');
  });
});

describe('the source layout also resolves the checker', () => {
  test('running the hook from hooks/claude finds tools/plan-gate two levels up', () => {
    expect(ask(sourceHook, edit()).verdict).toBe('deny');
  });
});
