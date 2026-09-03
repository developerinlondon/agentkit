import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repoRoot = dirname(dirname(import.meta.dir));
const hook = join(repoRoot, 'hooks', 'claude', 'wait-police.sh');
const pluginHook = join(repoRoot, 'plugins-cc', 'agentkit', 'hooks', 'wait-police.sh');

let home: string;
let workdir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentkit-wait-home-'));
  workdir = mkdtempSync(join(tmpdir(), 'agentkit-wait-cwd-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

type Entry = Record<string, unknown>;

function assistant(...blocks: Entry[]): Entry {
  return { type: 'assistant', message: { role: 'assistant', content: blocks } };
}

function user(...blocks: Entry[]): Entry {
  return { type: 'user', message: { role: 'user', content: blocks } };
}

function bgStart(id: string, command: string, toolUseId = `toolu_${id}`): Entry[] {
  return [
    assistant({
      type: 'tool_use',
      id: toolUseId,
      name: 'Bash',
      input: { command, run_in_background: true },
    }),
    user({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        `Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output. You will be notified when it completes.`,
    }),
  ];
}

function bgDone(id: string): Entry {
  return user({
    type: 'text',
    text:
      `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`,
  });
}

function spawnAgent(name: string): Entry[] {
  return [
    assistant({
      type: 'tool_use',
      id: `toolu_${name}`,
      name: 'Agent',
      input: { name, description: `run ${name}`, subagent_type: 'general-purpose' },
    }),
    user({
      type: 'tool_result',
      tool_use_id: `toolu_${name}`,
      content: [{ type: 'text', text: `Spawned successfully.\nagent_id: ${name}@team\nname: ${name}` }],
    }),
  ];
}

function agentIdle(name: string): Entry {
  return user({
    type: 'text',
    text:
      `Another Claude session sent a message:\n<teammate-message teammate_id="${name}">\n{"type":"idle_notification","from":"${name}","idleReason":"available","result":"done"}\n</teammate-message>`,
  });
}

function sendMessage(to: string): Entry {
  return assistant({ type: 'tool_use', id: `toolu_msg_${to}`, name: 'SendMessage', input: { to, message: 'more' } });
}

function transcript(entries: Entry[]): string {
  const path = join(workdir, 'transcript.jsonl');
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return path;
}

interface RunOptions {
  stopHookActive?: boolean;
  env?: Record<string, string>;
  hookPath?: string;
  transcriptPath?: string;
}

function run(entries: Entry[], options: RunOptions = {}) {
  const payload = JSON.stringify({
    session_id: 'test-session',
    transcript_path: options.transcriptPath ?? transcript(entries),
    cwd: workdir,
    hook_event_name: 'Stop',
    stop_hook_active: options.stopHookActive ?? false,
  });
  const result = spawnSync('bash', [options.hookPath ?? hook], {
    input: payload,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ...(options.env ?? {}) },
  });
  expect(result.status).toBe(0);
  return `${result.stdout ?? ''}`;
}

const blocked = (out: string) => out.trim().length > 0 && JSON.parse(out).decision === 'block';
const reason = (out: string) => JSON.parse(out).reason as string;

describe('wait-police detects live delegated work', () => {
  test('a session with nothing delegated stops silently', () => {
    expect(run([assistant({ type: 'text', text: 'all done' })])).toBe('');
  });

  test('a background task with no notification blocks, naming the task and its command', () => {
    const out = run(bgStart('bxyz123', 'bun run build --release'));
    expect(blocked(out)).toBe(true);
    expect(reason(out)).toContain('bxyz123');
    expect(reason(out)).toContain('bun run build');
    expect(reason(out)).toContain('wait-for --cap');
  });

  test('a background task that already notified is not live', () => {
    expect(run([...bgStart('bxyz123', 'bun run build'), bgDone('bxyz123')])).toBe('');
  });

  test('a running subagent blocks, naming the subagent', () => {
    const out = run(spawnAgent('lane-a'));
    expect(blocked(out)).toBe(true);
    expect(reason(out)).toContain('lane-a');
  });

  test('a subagent that reported idle is not live', () => {
    expect(run([...spawnAgent('lane-a'), agentIdle('lane-a')])).toBe('');
  });

  test('messaging an idle subagent puts it back to work', () => {
    const out = run([...spawnAgent('lane-a'), agentIdle('lane-a'), sendMessage('lane-a')]);
    expect(blocked(out)).toBe(true);
    expect(reason(out)).toContain('lane-a');
  });
});

describe('wait-police recognises an armed poll', () => {
  test('a live wait-for task lets the turn end', () => {
    expect(run(bgStart('bpoll', 'wait-for --cap 1800 --every 30 --pr-checks owner/repo 437'))).toBe('');
  });

  test('a hand-rolled loop carrying its own deadline counts', () => {
    const command =
      'deadline=$(( $(date +%s) + 900 )); while [ $(date +%s) -lt $deadline ]; do gh pr view 1 && break; sleep 30; done';
    expect(run(bgStart('bpoll', command))).toBe('');
  });

  test('a timeout-capped watch counts', () => {
    expect(run(bgStart('bpoll', 'timeout 900 gh run watch 123 -R owner/repo'))).toBe('');
  });

  test('a bare watch with no deadline does not count', () => {
    const out = run(bgStart('bwatch', 'gh pr checks 437 -R owner/repo --watch'));
    expect(blocked(out)).toBe(true);
    expect(reason(out)).toContain('bwatch');
  });

  test('an uncapped sleep loop does not count', () => {
    const out = run(bgStart('bloop', 'while true; do gh pr view 1; sleep 30; done'));
    expect(blocked(out)).toBe(true);
  });

  test('an armed poll covers a subagent running alongside it', () => {
    expect(run([...spawnAgent('lane-a'), ...bgStart('bpoll', 'wait-for --cap 600 --every 20 --url https://x.test')]))
      .toBe('');
  });

  test('a poll that already finished stops covering anything', () => {
    const out = run([
      ...spawnAgent('lane-a'),
      ...bgStart('bpoll', 'wait-for --cap 600 --every 20 --url https://x.test'),
      bgDone('bpoll'),
    ]);
    expect(blocked(out)).toBe(true);
    expect(reason(out)).toContain('lane-a');
  });
});

describe('wait-police cannot trap a session', () => {
  test('stop_hook_active suppresses a second consecutive block', () => {
    expect(run(spawnAgent('lane-a'), { stopHookActive: true })).toBe('');
  });

  test('a missing transcript fails open and says so in the audit log', () => {
    const out = run([], { transcriptPath: join(workdir, 'absent.jsonl') });
    expect(out).toBe('');
    expect(readFileSync(join(home, '.agentkit', 'wait-audit.log'), 'utf-8')).toContain('OPEN');
  });

  test('unparseable transcript lines do not hide the events around them', () => {
    const path = join(workdir, 'mixed.jsonl');
    const good = bgStart('bxyz123', 'bun run build');
    writeFileSync(
      path,
      `not json at all\n${good.map((e) => JSON.stringify(e)).join('\n')}\n{"truncated": \n`,
    );
    expect(blocked(run([], { transcriptPath: path }))).toBe(true);
  });

  test('a block is recorded in the audit log', () => {
    run(spawnAgent('lane-a'));
    expect(readFileSync(join(home, '.agentkit', 'wait-audit.log'), 'utf-8')).toContain('BLOCK');
  });
});

describe('wait-police kill switches', () => {
  test('AGENTKIT_SKIP_HOOKS names the unit', () => {
    expect(run(spawnAgent('lane-a'), { env: { AGENTKIT_SKIP_HOOKS: 'wait-police' } })).toBe('');
    expect(run(spawnAgent('lane-a'), { env: { AGENTKIT_SKIP_HOOKS: 'coding-police, wait-police' } })).toBe('');
    expect(run(spawnAgent('lane-a'), { env: { AGENTKIT_SKIP_HOOKS: 'all' } })).toBe('');
    expect(blocked(run(spawnAgent('lane-a'), { env: { AGENTKIT_SKIP_HOOKS: 'prose-police' } }))).toBe(true);
  });

  test('the repository can turn it off with git config', () => {
    spawnSync('git', ['init', '-q', workdir]);
    spawnSync('git', ['-C', workdir, 'config', 'agentkit.waitpolice.enabled', 'false']);
    expect(run(spawnAgent('lane-a'))).toBe('');
    spawnSync('git', ['-C', workdir, 'config', 'agentkit.waitpolice.enabled', 'true']);
    expect(blocked(run(spawnAgent('lane-a')))).toBe(true);
  });

  test('config.yaml can turn it off globally', () => {
    const config = join(home, '.config', 'agentkit');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'config.yaml'), 'wait-police:\n  enabled: false\n');
    expect(run(spawnAgent('lane-a'))).toBe('');
    writeFileSync(join(config, 'config.yaml'), 'wait-police:\n  enabled: true\n');
    expect(blocked(run(spawnAgent('lane-a')))).toBe(true);
  });

  test('another unit\'s disabled section is not this one\'s', () => {
    const config = join(home, '.config', 'agentkit');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'config.yaml'), 'prose-police:\n  enabled: false\n');
    expect(blocked(run(spawnAgent('lane-a')))).toBe(true);
  });
});

describe('the packaged copy behaves the same', () => {
  test('the plugin hook blocks and allows identically', () => {
    expect(blocked(run(spawnAgent('lane-a'), { hookPath: pluginHook }))).toBe(true);
    expect(run([...spawnAgent('lane-a'), agentIdle('lane-a')], { hookPath: pluginHook })).toBe('');
  });
});
