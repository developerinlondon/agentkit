import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const hook = join(repoRoot, 'hooks', 'claude', 'comment-police.sh');
const pluginHook = join(repoRoot, 'plugins-cc', 'agentkit', 'hooks', 'comment-police.sh');

function run(added: string, filePath = '/tmp/subject.ts', hookPath = hook): string {
  const payload = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: filePath, new_string: added },
  });
  const result = spawnSync('bash', [hookPath], { input: payload, encoding: 'utf-8' });
  expect(result.status).toBe(0);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

const flagged = (out: string) => out.includes('COMMENT DISCIPLINE VIOLATION');

describe('comment-police hook', () => {
  test('a forge reference is rejected in every form an agent actually writes', () => {
    const forms = [
      '// Drain window (#170): the backend has nothing left to cancel',
      '// Pairs with some-repo!31 for the daemon side',
      '// see https://gitlab.com/org/repo/-/merge_requests/466',
      '// behaviour reverted in commit a09d020b',
      '// Two-screens principle (plan 024)',
      '// as part of this MR the gate moved',
    ];
    for (const form of forms) {
      const out = run(`${form}\nconst a = 1;\n`);
      expect(flagged(out)).toBe(true);
      expect(out).toContain('FORGE REFERENCE');
    }
  });

  test('the reason a comment states itself is kept', () => {
    const out = run('// Head, not tail: the sentence worth speaking announces the call.\nconst a = 1;\n');
    expect(flagged(out)).toBe(false);
  });

  test('block length is bounded, and the boundary is not off by one', () => {
    const six = Array.from({ length: 6 }, (_, i) => `// line ${i}`).join('\n');
    const seven = Array.from({ length: 7 }, (_, i) => `// line ${i}`).join('\n');
    expect(flagged(run(`${six}\nconst a = 1;\n`))).toBe(false);
    const out = run(`${seven}\nconst a = 1;\n`);
    expect(flagged(out)).toBe(true);
    expect(out).toContain('COMMENT BLOCK TOO LONG');
  });

  test('a comment-heavy edit is flagged on ratio even with short blocks', () => {
    const body = Array.from({ length: 8 }, (_, i) => `// note ${i}\nconst v${i} = ${i};`).join('\n');
    const out = run(`${body}\n`);
    expect(flagged(out)).toBe(true);
    expect(out).toContain('TOO MANY COMMENTS');
  });

  test('a shebang is not a forge reference', () => {
    expect(flagged(run('#!/usr/bin/env bash\nset -euo pipefail\n', '/tmp/subject.sh'))).toBe(false);
  });

  test('prose files are left alone', () => {
    const many = Array.from({ length: 9 }, (_, i) => `# heading ${i}`).join('\n');
    expect(flagged(run(many, '/tmp/subject.md'))).toBe(false);
  });

  test('a ref inside code rather than a comment is not the hook\'s business', () => {
    expect(flagged(run('const url = "https://gitlab.com/org/repo/-/issues/12";\n'))).toBe(false);
  });

  test('the plugin copy behaves identically to the claude copy', () => {
    const sample = '// Drain window (#170): nothing to cancel\nconst a = 1;\n';
    expect(flagged(run(sample, '/tmp/subject.ts', pluginHook))).toBe(true);
    expect(flagged(run('// A single honest reason.\nconst a = 1;\n', '/tmp/subject.ts', pluginHook))).toBe(false);
  });
});
