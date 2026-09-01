import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  }, 20000);

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

  test('.txt prose is covered, not just markdown', () => {
    expect(run('We delve into a rich tapestry.\n', '/tmp/prose-subject/notes.txt').status).toBe(2);
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
    // wc -w counts each " — " as a word too. Five dashes over 185 total words
    // stays inside 3-per-100; five over 161 crosses it.
    const withinRatio = Array.from({ length: 6 }, () => words(30)).join(' — ') + '.\n';
    const overRatio = Array.from({ length: 6 }, () => words(26)).join(' — ') + '.\n';
    expect(flagged(run(withinRatio).out)).toBe(false);
    const { out } = run(overRatio);
    expect(flagged(out)).toBe(true);
    expect(out).toContain('EM-DASH PILE-UP');
  });

  test('fewer than 4 dashes never trips density, even under a stricter configured ratio', () => {
    // At the default 2-per-100 the ratio already implies 4+ dashes; the floor
    // exists so a tightened config cannot flag a text over two dashes.
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-prose-cfg-'));
    mkdirSync(join(dir, 'agentkit'), { recursive: true });
    writeFileSync(join(dir, 'agentkit', 'config.yaml'), 'prose-police:\n  max-em-dash-per-100-words: 1\n');
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const twoDashes = `${words(80)} — ${words(80)} — ${words(10)}.\n`;
    const r = run(twoDashes, '/tmp/prose-subject/doc.md', hook, { XDG_CONFIG_HOME: dir });
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('short edits are never density-checked', () => {
    expect(flagged(run('a — b — c — d — e\n').out)).toBe(false);
  });

  test('long dash-free prose does not kill the hook under pipefail', () => {
    // grep exits 1 on zero em dashes; unguarded, pipefail turned that into a
    // silent exit 1 that swallowed every phrase finding already collected.
    const filler = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
    const slop = run(`We delve into a rich tapestry. ${filler}.\n`);
    expect(slop.status).toBe(2);
    expect(slop.out).toContain('AI-TELL PHRASING');
    expect(run(`${filler}.\n`).status).toBe(0);
  });

  test('the violation names the matched phrase, not just the line', () => {
    const { out } = run(`This design ${'x'.repeat(120)} aims to leverage caching.\n`);
    expect(out).toContain('"to leverage"');
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

  test('every shipped pattern has a killing exemplar', () => {
    // One sentence per SLOP_PATTERNS entry: deleting any pattern makes its
    // exemplar pass, so each line of the list is load-bearing under mutation.
    const exemplars = [
      'We delve into the details.',
      'A rich tapestry of services.',
      'A plethora of options.',
      'A myriad of tools.',
      'A treasure trove of data.',
      'The synergy between teams.',
      'This is a paradigm shift.',
      'A real game-changer.',
      'Cutting-edge technology.',
      'A groundbreaking approach.',
      'It will revolutionize deploys.',
      'A holistic approach.',
      'We embark on a rewrite.',
      'Elevate your workflow.',
      'Unlock the full potential.',
      'Harness the power of hooks.',
      'We navigate the complexity of auth.',
      'A double-edged sword.',
      'It leverages caching.',
      'We leverage caching.',
      'A testament to good design.',
      'It stands as a testament.',
      'It plays a crucial role.',
      'This underscores the importance of tests.',
      'The evolving landscape of AI.',
      'A pivotal moment for the team.',
      "In today's fast-paced world.",
      'In the realm of infrastructure.',
      'At the end of the day, it ships.',
      "It's worth noting that it works.",
      'Needless to say, it failed.',
      'Great question!',
      "You're absolutely right.",
      'I hope this helps.',
      "Let's dive into the config.",
      'We dive deeper into the stack.',
      'Without further ado, the results.',
      "This isn't just a linter, but a philosophy.",
      "It's not a tool, it's a movement.",
    ];
    for (const sentence of exemplars) {
      expect(flagged(run(`${sentence}\n`).out), sentence).toBe(true);
    }
    // 39 hook spawns: well over bun's 5s default under full-suite load.
  }, 60000);

  test('ordinary engineering prose the patterns must NOT catch', () => {
    const clean = [
      'The failover is seamless: connections drain before the old pod terminates.',
      'Do not simply delete the file, but move it to the archive directory.',
      'DNS resolution plays a key role in the outage we saw on Tuesday.',
      'This uses financial leverage of 3x, which the risk model caps.',
      'The leverage in this negotiation favors the vendor.',
    ];
    for (const sentence of clean) {
      expect(flagged(run(`${sentence}\n`).out), sentence).toBe(false);
    }
  }, 20000);

  test('global config can disable the hook and add excludes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-prose-gcfg-'));
    mkdirSync(join(dir, 'agentkit'), { recursive: true });
    const slop = 'We delve into a rich tapestry.\n';
    writeFileSync(join(dir, 'agentkit', 'config.yaml'), 'prose-police:\n  enabled: false\n');
    expect(run(slop, '/tmp/prose-subject/doc.md', hook, { XDG_CONFIG_HOME: dir }).status).toBe(0);
    writeFileSync(
      join(dir, 'agentkit', 'config.yaml'),
      'prose-police:\n  exclude-patterns:\n    - docs/marketing/\n',
    );
    expect(run(slop, '/tmp/prose-subject/docs/marketing/post.md', hook, { XDG_CONFIG_HOME: dir }).status).toBe(0);
    expect(run(slop, '/tmp/prose-subject/docs/plain.md', hook, { XDG_CONFIG_HOME: dir }).status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the plugin copy behaves identically to the claude copy', () => {
    expect(flagged(run('We delve into a rich tapestry.\n', '/tmp/prose-subject/doc.md', pluginHook).out)).toBe(true);
    expect(flagged(run('Plain and specific.\n', '/tmp/prose-subject/doc.md', pluginHook).out)).toBe(false);
  });
});
