import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeSandbox, repoRoot, sandboxEnv, type Sandbox, toolTimeoutMs } from './fixture';

const planGate = join(repoRoot, 'tools', 'plan-gate');

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox('plan-gate-');
});

afterEach(() => {
  rmSync(box.root, { recursive: true, force: true });
});

function judge(content: string, args: string[] = [], name = '/tmp/plan.md') {
  return spawnSync(planGate, [...args, '--stdin', name], {
    encoding: 'utf8',
    input: content,
    env: sandboxEnv(box),
    timeout: toolTimeoutMs,
  });
}

function statuses(content: string): Record<string, string> {
  const result = judge(content, ['--all', '--tsv']);
  expect(result.stderr).toBe('');
  const map: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [status, , , text] = line.split('\t');
    map[text] = status;
  }
  return map;
}

const planWithGaps = [
  '# Plan 057 — device exec',
  '',
  '**Status**: Done',
  '',
  '## Known gaps',
  '',
  '- exec_mode/exec_allow have no UI — Highest-value remaining item',
  '- [x] incident rows are written but never rendered',
  '- ~~reflex audit double counts~~',
  '- approval gate has no timeout, tracked in #311',
  '- rate limiting is per-node only',
  '',
  '## Next steps',
  '',
  '- ship it',
  '',
].join('\n');

describe('gap classification', () => {
  test('an untracked, unticked gap blocks', () => {
    const result = judge(planWithGaps);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('exec_mode/exec_allow have no UI');
    expect(result.stdout).toContain('rate limiting is per-node only');
  });

  test('a ticked, struck-through, or issue-bearing gap does not block', () => {
    const map = statuses(planWithGaps);
    expect(map['incident rows are written but never rendered']).toBe('CLOSED');
    expect(map['~~reflex audit double counts~~']).toBe('CLOSED');
    expect(map['approval gate has no timeout, tracked in #311']).toBe('TRACKED');
    expect(map['exec_mode/exec_allow have no UI — Highest-value remaining item']).toBe('OPEN');
  });

  test('an issue named on a sub-bullet still tracks the gap above it', () => {
    const map = statuses('## Known gaps\n\n- the retry path is unbuilt\n  - filed as #42\n');
    expect(map['the retry path is unbuilt']).toBe('TRACKED');
  });

  test('a GitLab merge-request reference tracks a gap', () => {
    const map = statuses('## Known gaps\n\n- the retry path is unbuilt, see !42\n');
    expect(map['the retry path is unbuilt, see !42']).toBe('TRACKED');
  });

  test('an issue URL tracks a gap', () => {
    const map = statuses('## Known gaps\n\n- unbuilt https://forge.invalid/a/b/-/issues/7\n');
    expect(map['unbuilt https://forge.invalid/a/b/-/issues/7']).toBe('TRACKED');
  });

  test('items outside the gaps section are not gaps', () => {
    const result = judge(planWithGaps, ['--all', '--tsv']);
    expect(result.stdout).not.toContain('ship it');
  });

  test('a gaps heading inside a fenced block is sample text', () => {
    const content = ['# P', '', '```md', '## Known gaps', '', '- a documented example gap', '```', ''].join('\n');
    const result = judge(content);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('a deeper subheading does not end the section', () => {
    const content = ['## Known gaps', '', '- first', '', '### Detail', '', '- second', ''].join('\n');
    const map = statuses(content);
    expect(map.first).toBe('OPEN');
    expect(map.second).toBe('OPEN');
  });
});

describe('done gating', () => {
  test('--require-done stays silent while the plan does not claim done', () => {
    const inProgress = planWithGaps.replace('**Status**: Done', '**Status**: In progress');
    const result = judge(inProgress, ['--require-done']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('--require-done blocks once the plan claims done', () => {
    const result = judge(planWithGaps, ['--require-done']);
    expect(result.status).toBe(1);
  });

  test('several spellings of done are recognised', () => {
    for (const marker of ['Status: shipped', '**Status**: Complete', '## Status: DELIVERED']) {
      const content = `# P\n\n${marker}\n\n## Known gaps\n\n- untracked thing\n`;
      expect(judge(content, ['--require-done']).status).toBe(1);
    }
  });

  test('a done plan whose gaps are all closed or tracked passes', () => {
    const content = '# P\n\nStatus: Done\n\n## Known gaps\n\n- [x] a\n- b #12\n- ~~c~~\n';
    expect(judge(content, ['--require-done']).status).toBe(0);
  });
});

describe('configuration', () => {
  function withConfig(yaml: string, planBody: string) {
    const configDir = join(box.home, '.config', 'agentkit');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), yaml);
    return judge(planBody, ['--all', '--tsv']);
  }

  test('gap-headings can name a project-specific section', () => {
    const body = '## Loose ends\n\n- something unfinished\n';
    expect(judge(body, ['--tsv']).stdout).toBe('');
    const result = withConfig('wip:\n  gap-headings: "loose ends"\n', body);
    expect(result.stdout).toContain('something unfinished');
  });

  test('a repository config overrides the global one', () => {
    const configDir = join(box.home, '.config', 'agentkit');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'wip:\n  gap-headings: "loose ends"\n');

    const repo = join(box.root, 'r');
    mkdirSync(join(repo, '.agentkit'), { recursive: true });
    mkdirSync(join(repo, 'plans'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'config.yaml'), 'wip:\n  gap-headings: "snags"\n');
    writeFileSync(join(repo, 'plans', 'p.md'), '## Snags\n\n- repo-level heading won\n');

    const result = spawnSync(planGate, ['--repo', repo, '--tsv'], {
      encoding: 'utf8',
      env: sandboxEnv(box),
      timeout: toolTimeoutMs,
    });
    expect(result.stdout).toContain('repo-level heading won');
  });

  test('plan-paths replaces the discovered layout', () => {
    const repo = join(box.root, 'r2');
    mkdirSync(join(repo, '.agentkit'), { recursive: true });
    mkdirSync(join(repo, 'design'), { recursive: true });
    writeFileSync(join(repo, '.agentkit', 'config.yaml'), 'wip:\n  plan-paths:\n    - design\n');
    writeFileSync(join(repo, 'design', 'd.md'), '## Known gaps\n\n- found via plan-paths\n');

    const listed = spawnSync(planGate, ['--repo', repo, '--list-plans'], {
      encoding: 'utf8',
      env: sandboxEnv(box),
      timeout: toolTimeoutMs,
    });
    expect(listed.stdout).toContain('design/d.md');

    const result = spawnSync(planGate, ['--repo', repo, '--tsv'], {
      encoding: 'utf8',
      env: sandboxEnv(box),
      timeout: toolTimeoutMs,
    });
    expect(result.stdout).toContain('found via plan-paths');
  });
});

describe('path matching', () => {
  test('--matches accepts a plan path that does not exist yet', () => {
    const repo = join(box.root, 'r3');
    mkdirSync(join(repo, 'plans'), { recursive: true });
    const yes = spawnSync(planGate, ['--repo', repo, '--matches', join(repo, 'plans', 'unwritten.md')], {
      encoding: 'utf8',
      env: sandboxEnv(box),
      timeout: toolTimeoutMs,
    });
    expect(yes.status).toBe(0);
    const no = spawnSync(planGate, ['--repo', repo, '--matches', join(repo, 'README.md')], {
      encoding: 'utf8',
      env: sandboxEnv(box),
      timeout: toolTimeoutMs,
    });
    expect(no.status).toBe(1);
  });
});

describe('reporting', () => {
  test('an unreadable target is a fault, not a clean plan', () => {
    const result = spawnSync(planGate, [join(box.root, 'missing.md')], {
      encoding: 'utf8',
      env: sandboxEnv(box),
      timeout: toolTimeoutMs,
    });
    expect(result.status).toBe(3);
  });

  test('a long gap line says it was truncated', () => {
    const long = 'x'.repeat(400);
    const result = judge(`## Known gaps\n\n- ${long}\n`);
    expect(result.stdout).toContain('truncated for display');
  });
});
