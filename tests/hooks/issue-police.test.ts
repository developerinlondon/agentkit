import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dir, '..', '..', 'hooks', 'claude', 'issue-police.sh');

let root: string;

function runHook(command: string, cwd?: string): string {
  const res = spawnSync('bash', [HOOK], {
    cwd: cwd ?? root,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
  });
  return res.stdout ?? '';
}

function denied(command: string, cwd?: string): boolean {
  return runHook(command, cwd).includes('"deny"');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-issuepolice-'));
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('issue-police: the disposition line is required', () => {
  test('a GitHub issue with no disposition is refused', () => {
    const out = runHook('gh issue create --title "flaky test" --body "it fails sometimes"');
    expect(out).toContain('"deny"');
    expect(out).toContain('why it is being filed rather than fixed');
  });

  test('a GitLab issue with no disposition is refused', () => {
    expect(denied('glab issue create --title "flaky test" --description "it fails"')).toBe(true);
  });

  test('an interactive create with no body at all is refused', () => {
    expect(denied('gh issue create --title "flaky test"')).toBe(true);
  });

  test('a bare marker with nothing after it is not a way through', () => {
    expect(denied('gh issue create --title x --body "Disposition:"')).toBe(true);
    expect(denied('gh issue create --title x --body "Disposition:   "')).toBe(true);
  });
});

describe('issue-police: every disposition the refusal offers actually works', () => {
  // The refusal names example lines. Each one is lifted straight out of the
  // message and replayed, so the hook cannot suggest a form its own parser
  // rejects — the whole point of a refusal that tells you what to do.
  const refusal = runHookOnce();

  function runHookOnce(): string {
    const res = spawnSync('bash', [HOOK], {
      cwd: tmpdir(),
      input: JSON.stringify({ tool_input: { command: 'gh issue create --title x' } }),
      encoding: 'utf-8',
    });
    return res.stdout ?? '';
  }

  const examples = [...refusal.matchAll(/ {2}(Disposition: [^"\\]+?)\\n/g)].map((m) => m[1]);

  test('the refusal offers examples at all', () => {
    expect(examples.length).toBeGreaterThanOrEqual(3);
  });

  for (const example of examples) {
    test(`"${example}" passes`, () => {
      expect(denied(`gh issue create --title x --body "${example}"`)).toBe(false);
    });
  }
});

describe('issue-police: where the disposition may live', () => {
  test('inline in the body', () => {
    expect(denied('gh issue create --title x --body "Disposition: new work"')).toBe(false);
  });

  test('in a --body-file the hook can read', () => {
    const body = join(root, 'body.md');
    writeFileSync(body, 'Some detail.\n\nDisposition: new work, unrelated to anything in flight\n');
    expect(denied(`gh issue create --title x --body-file ${body}`)).toBe(false);
  });

  test('a --body-file without the line is still refused', () => {
    const body = join(root, 'nodisp.md');
    writeFileSync(body, 'Some detail with no disposition at all.\n');
    expect(denied(`gh issue create --title x --body-file ${body}`)).toBe(true);
  });

  test('a relative --body-file resolves against a cd prefix, not the hook cwd', () => {
    const dir = join(root, 'elsewhere');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'issue.md'), 'Disposition: new work\n');
    expect(denied(`cd ${dir} && gh issue create --title x --body-file issue.md`)).toBe(false);
  });

  test('a heredoc body carries it too', () => {
    const command = `gh issue create --title x --body "$(cat <<'EOF'
Root cause: unknown.

Disposition: review finding, not fixable in the change that caused it because it needs a schema decision
EOF
)"`;
    expect(denied(command)).toBe(false);
  });

  test('a body piped in on stdin cannot be read, and the refusal says so', () => {
    const out = runHook('cat body.md | gh issue create --title x --body-file -');
    expect(out).toContain('"deny"');
    expect(out).toContain('stdin');
  });

  test('the short -F form is read as a body file', () => {
    const body = join(root, 'shortflag.md');
    writeFileSync(body, 'Disposition: new work\n');
    expect(denied(`gh issue create --title x -F ${body}`)).toBe(false);
  });
});

describe('issue-police: what it does not touch', () => {
  const untouched = [
    'gh issue list --author @me',
    'gh issue comment 12 --body "no disposition here"',
    'gh issue close 12 --reason completed',
    'gh pr create --title x --body "no disposition here"',
    'glab mr create --title x --assignee @me',
    'glab issue list',
    'git commit -m "gh issue create"',
  ];

  for (const command of untouched) {
    test(`${command} passes untouched`, () => {
      expect(runHook(command).trim()).toBe('');
    });
  }
});

describe('issue-police: harness compatibility', () => {
  test('a Grok camelCase payload is read the same way', () => {
    const res = spawnSync('bash', [HOOK], {
      cwd: root,
      input: JSON.stringify({ toolName: 'bash', toolInput: { command: 'gh issue create -t x' } }),
      encoding: 'utf-8',
    });
    expect(res.stdout ?? '').toContain('"deny"');
  });
});
