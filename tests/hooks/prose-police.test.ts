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

function runBash(
  command: string,
  env: Record<string, string> = {},
): { out: string; status: number | null } {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const result = spawnSync('bash', [hook], {
    input: payload,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return { out: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status };
}

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
      '/tmp/repo/instructions/anti-glaze.md',
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

  test('the word floor is pinned from below: 4 dashes under 150 words stays silent', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const fourDashesUnderFloor = Array.from({ length: 5 }, () => words(19)).join(' — ') + '.\n';
    expect(flagged(run(fourDashesUnderFloor).out)).toBe(false);
  });

  test('missing jq fails open, as the FAQ promises', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-prose-nojq-'));
    const r = spawnSync('/bin/bash', [hook], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/prose-subject/doc.md', content: 'We delve into a rich tapestry.\n' },
      }),
      encoding: 'utf-8',
      env: { PATH: '', HOME: dir, XDG_CONFIG_HOME: dir },
    });
    rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBe(0);
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
      'The morning pass runs at 9.',
      'The morning briefing lists the failures.',
      'This morning the build broke.',
      'We ship tonight.',
      'This evening the deploy lands.',
      'This afternoon we cut the tag.',
      'The batch runs overnight.',
      'Later today the cache clears.',
      'First thing tomorrow, check the logs.',
    ];
    for (const sentence of exemplars) {
      expect(flagged(run(`${sentence}\n`).out), sentence).toBe(true);
    }
    // 48 hook spawns: well over bun's 5s default under full-suite load.
  }, 90000);

  test('ordinary engineering prose the patterns must NOT catch', () => {
    const clean = [
      'The failover is seamless: connections drain before the old pod terminates.',
      'Do not simply delete the file, but move it to the archive directory.',
      'DNS resolution plays a key role in the outage we saw on Tuesday.',
      'This uses financial leverage of 3x, which the risk model caps.',
      'The leverage in this negotiation favors the vendor.',
      'A reply at two in the morning must not get a letter at nine.',
      'The queue drains in the morning for readers in Sydney.',
      'The first thing to check is the log.',
      'First things first: read the lockfile.',
    ];
    for (const sentence of clean) {
      expect(flagged(run(`${sentence}\n`).out), sentence).toBe(false);
    }
  }, 20000);

  test('time-of-day naming is flagged, and the remedy names the fix', () => {
    // An agent working in the small hours named a product routine "the morning
    // pass"; the readers it serves are on other clocks.
    const { out, status } = run('The morning pass runs at 9.\n');
    expect(status).toBe(2);
    expect(out).toContain('AI-TELL PHRASING');
    expect(out).toContain('"morning pass"');
    expect(out).toContain('name the thing by what it does');
  });

  test('a clock-time example is the reader\'s day, not the agent\'s, and passes', () => {
    const clean = [
      'A reply at two in the morning must not get a letter at nine.',
      'Good morning is the greeting the template opens with.',
      'The pass runs daily at 09:00 UTC.',
    ];
    for (const sentence of clean) {
      expect(flagged(run(`${sentence}\n`).out), sentence).toBe(false);
    }
  }, 20000);

  test('time-of-day naming inside a code fence is a snippet, not prose', () => {
    const text = '```\nthe morning pass runs overnight and ships tonight\n```\nA plain sentence outside the fence.\n';
    expect(flagged(run(text).out)).toBe(false);
    expect(flagged(run('The scheduler key is `overnight` in the config.\n').out)).toBe(false);
  });

  test('the rule that teaches the time-of-day patterns is exempt', () => {
    const rule = 'Never write "the morning pass", "tonight", or "first thing tomorrow".\n';
    expect(run(rule, '/tmp/repo/rules/writing-discipline.md').out).toBe('');
    expect(run(rule, '/tmp/repo/docs/prose-police.md').out).toBe('');
  });

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

  test('inline gh/glab text is policed through the Bash arm', () => {
    const deny = (cmd: string) => {
      const r = runBash(cmd);
      expect(r.status, cmd).toBe(0);
      const parsed = JSON.parse(r.out);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parsed.reason).toContain('PROSE DISCIPLINE VIOLATION');
      return parsed.reason as string;
    };
    const allow = (cmd: string) => {
      const r = runBash(cmd);
      expect(r.status, cmd).toBe(0);
      expect(r.out.trim(), cmd).toBe('');
    };

    expect(deny('gh issue create --title "t" --body "We delve into a rich tapestry of synergy."')).toContain('"delve"');
    deny('gh pr create --title "A groundbreaking game-changer" --body "plain"');
    deny('glab mr create -d "This stands as a testament to synergy." -t "ok"');
    deny('gh api --method POST repos/o/r/issues --field body="We delve into a tapestry."');

    // The Bash-arm remedy must never tell an agent to add backticks inside a
    // double-quoted body — that is command substitution, not quoting.
    const noteReason = deny('glab mr note 12 -m "We delve into a rich tapestry."');
    expect(noteReason).toContain('single-quote the whole body');
    expect(noteReason).not.toContain('Put the quotation in backticks');
    deny('gh issue close 7 --comment "A groundbreaking paradigm shift resolved this."');

    deny('GH_TOKEN=x gh issue create --body "We delve into a rich tapestry."');
    deny('gh release create v1 --notes "A groundbreaking cutting-edge release."');
    deny('gh issue create -b "We delve into a rich tapestry." --title t');
    deny('glab mr create --description "This stands as a testament to synergy." --title t');
    deny('cd /tmp && gh issue create --body "We delve into a rich tapestry."');
    deny('gh api repos/o/r/issues -F body="We delve into a rich tapestry."');

    allow('gh issue create --title "prose-police inline arm" --body "Reads inline forge text through shlex."');
    allow('gh issue create --body-file - --title "plain title"');
    allow('curl -d "we delve into a tapestry" https://example.com');
    allow('echo "gh issue create --body \\"we delve into a tapestry\\""');
    // Scoping: text belonging to a DIFFERENT simple command on the line is
    // not forge text, even with gh/glab present.
    allow('git commit -m "We delve into a rich tapestry of synergy." && gh pr create --title t --body "plain"');
    allow('gh pr list && curl -X POST -d "We delve into a rich tapestry." https://x.example');
    allow('gh issue list | grep -b "we delve into a tapestry"');
  });

  test('a readable --body-file is scanned; slop in it denies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-prose-bodyfile-'));
    const file = join(dir, 'body');
    writeFileSync(file, 'We delve into a rich tapestry of synergy.\n');
    const r = runBash(`gh issue create --title t --body-file ${file}`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
    rmSync(dir, { recursive: true, force: true });
  });

  test('the Bash arm honours the kill switch', () => {
    const r = runBash('gh issue create --body "We delve into a rich tapestry."', { AGENTKIT_SKIP_HOOKS: 'prose-police' });
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe('');
  });

  test('the plugin copy behaves identically to the claude copy', () => {
    expect(flagged(run('We delve into a rich tapestry.\n', '/tmp/prose-subject/doc.md', pluginHook).out)).toBe(true);
    expect(flagged(run('Plain and specific.\n', '/tmp/prose-subject/doc.md', pluginHook).out)).toBe(false);
  });
});
