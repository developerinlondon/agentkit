import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repoRoot = join(import.meta.dir, '..', '..');
const hook = join(repoRoot, 'hooks', 'claude', 'prose-police.sh');
const pluginHook = join(repoRoot, 'plugins-cc', 'agentkit', 'hooks', 'prose-police.sh');

function run(
  added: string,
  filePath = '/tmp/prose-subject/doc.md',
  hookPath = hook,
  env: Record<string, string> = {},
): { out: string; status: number | null } {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: added },
  });
  const result = spawnSync('bash', [hookPath], {
    input: payload,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // Delivery is half the contract: Claude Code discards a PostToolUse hook's
  // stderr at exit 0, so a violation reported at 0 is one nobody hears.
  expect(result.status).toBe(out.includes('VIOLATION') ? 2 : 0);
  return { out, status: result.status };
}

const flagged = (out: string) => out.includes('PROSE DISCIPLINE VIOLATION');

describe('prose-police hook', () => {
  test('stock AI phrasing is rejected in the forms agents actually write', () => {
    const forms = [
      'This release delves into the rich tapestry of modern tooling.',
      "In today's fast-paced digital world, deployment matters.",
      'The hook stands as a testament to structural enforcement.',
      'Observability plays a crucial role in operations.',
      "It's worth noting that the cache is warm.",
      "This isn't just a linter, but a whole philosophy.",
      'We leverage synergy to unlock the full potential of your docs.',
      "Let's dive into the configuration.",
    ];
    for (const form of forms) {
      const { out } = run(`${form}\n`);
      expect(flagged(out), form).toBe(true);
      expect(out).toContain('AI-TELL PHRASING');
    }
  });

  test('plain specific prose passes', () => {
    const clean = [
      'The hook reads the added text, strips fenced code, and greps for the pattern list.',
      'Version 0.8.0 adds prose-police. Disable it per repo with git config.',
      'Two copies ship; the parity test keeps them byte-identical.',
    ].join('\n');
    expect(flagged(run(clean).out)).toBe(false);
  });

  test('fenced code blocks are not prose', () => {
    const text = '```\nwe delve into the tapestry and leverage synergy\n```\nA plain sentence outside the fence.\n';
    expect(flagged(run(text).out)).toBe(false);
  });

  test('inline code spans are not prose', () => {
    expect(flagged(run('The debugger is called `delve` and the crate is `tapestry`.\n').out)).toBe(false);
  });

  test("code files are not this hook's business", () => {
    const slop = 'const s = "we delve into a rich tapestry";\n';
    expect(run(slop, '/tmp/prose-subject/code.ts').out).toBe('');
  });

  test('the artifacts that teach the patterns are exempt', () => {
    const slop = 'delve tapestry leverage synergy\n';
    for (const path of [
      '/tmp/repo/CHANGELOG.md',
      '/tmp/repo/rules/writing-discipline.md',
      '/tmp/repo/skills/humanize/SKILL.md',
      '/tmp/repo/docs/prose-police.md',
    ]) {
      expect(run(slop, path).out).toBe('');
    }
  });

  test('em-dash density is bounded, and the boundary is not off by one', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    // 2 per 100 added words passes; 3 crosses the ratio.
    const two = `${words(50)} — ${words(25)} — ${words(25)}.\n`;
    const three = `${words(40)} — ${words(20)} — ${words(20)} — ${words(20)}.\n`;
    expect(flagged(run(two).out)).toBe(false);
    const { out } = run(three);
    expect(flagged(out)).toBe(true);
    expect(out).toContain('EM-DASH PILE-UP');
  });

  test('short edits are never density-checked', () => {
    expect(flagged(run('a — b — c — d — e\n').out)).toBe(false);
  });

  test('AGENTKIT_SKIP_HOOKS disables it, with the whitespace tolerance the others have', () => {
    const slop = 'We delve into a rich tapestry.\n';
    for (const value of ['prose-police', 'all', ' prose-police ', 'comment-police, prose-police', '\tall']) {
      const r = run(slop, '/tmp/prose-subject/doc.md', hook, { AGENTKIT_SKIP_HOOKS: value });
      expect(r.status, `AGENTKIT_SKIP_HOOKS=${JSON.stringify(value)}`).toBe(0);
    }
  });

  test('a repo can turn it off with git config agentkit.prosepolice.enabled false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-prose-off-'));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'agentkit.prosepolice.enabled', 'false');
    const r = run('We delve into a rich tapestry.\n', join(dir, 'doc.md'));
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the plugin copy behaves identically to the claude copy', () => {
    expect(flagged(run('We delve into a rich tapestry.\n', '/tmp/prose-subject/doc.md', pluginHook).out)).toBe(true);
    expect(flagged(run('Plain and specific.\n', '/tmp/prose-subject/doc.md', pluginHook).out)).toBe(false);
  });
});
