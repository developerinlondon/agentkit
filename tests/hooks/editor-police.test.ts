import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const HOOK = join(repoRoot, 'hooks', 'claude', 'editor-police.sh');
const TOOL = join(repoRoot, 'tools', 'wiki-editor');

const SESSION = 'sess-editor-test';
const ANA = 'Ana Example <ana@example.com>';
const TRAILER = `Edited-by: ${ANA}`;

let root: string;
let configDir: string;
let stateDir: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    XDG_CONFIG_HOME: configDir,
    XDG_STATE_HOME: stateDir,
    WIKI_EDITOR_BIN: TOOL,
    ...extra,
  };
}

function writeConfig(body: string): void {
  mkdirSync(join(configDir, 'agentkit'), { recursive: true });
  writeFileSync(join(configDir, 'agentkit', 'config.yaml'), body);
}

const CONFIG = `
git-police:
  branch-protection:
    allowed-repos: []
editor-police:
  # several people share one session
  enabled: true
  repos:
    - "myorg/*/wiki"
    - myorg/handbook
  editors:
    ana: "${ANA}"
    bo: 'Bo Example <bo@example.com>'
  fallback-email: team@example.com
`;

function runHook(
  command: string,
  opts: { cwd?: string; extra?: Record<string, string>; session?: string } = {},
): string {
  const res = spawnSync('bash', [HOOK], {
    cwd: opts.cwd ?? root,
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      session_id: opts.session ?? SESSION,
      cwd: opts.cwd ?? root,
    }),
    encoding: 'utf-8',
    env: env(opts.extra),
  });
  expect(res.status, `${command}\n${res.stderr}`).toBe(0);
  return res.stdout ?? '';
}

function tool(...args: string[]): { out: string; status: number | null } {
  const res = spawnSync('bash', [TOOL, ...args], { encoding: 'utf-8', env: env() });
  return { out: `${res.stdout ?? ''}${res.stderr ?? ''}`, status: res.status };
}

const denied = (out: string) => out.includes('"deny"');
const WIKI_COMMIT = 'git -C /srv/myorg/docs/wiki commit -m "docs: update"';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-editorpolice-'));
  configDir = join(root, 'config');
  stateDir = join(root, 'state');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('editor-police: inert unless configured', () => {
  test('no config file at all allows every commit', () => {
    rmSync(join(configDir, 'agentkit'), { force: true, recursive: true });
    expect(runHook(WIKI_COMMIT)).toBe('');
  });

  test('a config with no repos listed allows every commit', () => {
    writeConfig('editor-police:\n  enabled: true\n  repos: []\n');
    expect(runHook(WIKI_COMMIT)).toBe('');
  });

  test('enabled: false allows a commit in a listed repo', () => {
    writeConfig('editor-police:\n  enabled: false\n  repos:\n    - myorg/*/wiki\n');
    expect(runHook(WIKI_COMMIT)).toBe('');
  });
});

describe('editor-police: which commands and repos it judges', () => {
  beforeAll(() => {
    writeConfig(CONFIG);
    tool('clear', '--session', SESSION);
  });

  test('a commit in a repo the globs do not match is allowed', () => {
    expect(runHook('git -C /srv/myorg/docs/app commit -m x')).toBe('');
    expect(runHook('git -C /srv/other/docs/wiki commit -m x')).toBe('');
  });

  test('a commit in a matching repo named on the command line is refused', () => {
    expect(denied(runHook(WIKI_COMMIT))).toBe(true);
    expect(denied(runHook('git -C /srv/myorg/handbook commit -m x'))).toBe(true);
    expect(denied(runHook('cd /srv/myorg/docs/wiki && git commit -am x'))).toBe(true);
  });

  test('a commit whose working directory is inside a matching repo is refused', () => {
    const cwd = join(root, 'myorg', 'docs', 'wiki', 'pages');
    mkdirSync(cwd, { recursive: true });
    expect(denied(runHook('git commit -m x', { cwd }))).toBe(true);
  });

  test('the glob star does not cross a path separator', () => {
    expect(runHook('git -C /srv/myorg/a/b/wiki commit -m x')).toBe('');
  });

  test('git commands other than commit are not judged', () => {
    for (const cmd of [
      'git -C /srv/myorg/docs/wiki push origin main',
      'git -C /srv/myorg/docs/wiki status',
      'git -C /srv/myorg/docs/wiki log --format=%an',
      'echo "git commit" > /srv/myorg/docs/wiki/notes.txt',
    ]) {
      expect(runHook(cmd), cmd).toBe('');
    }
  });

  test('AGENTKIT_SKIP_HOOKS=editor-police switches it off for the session', () => {
    expect(runHook(WIKI_COMMIT, { extra: { AGENTKIT_SKIP_HOOKS: 'editor-police' } })).toBe('');
    expect(runHook(WIKI_COMMIT, { extra: { AGENTKIT_SKIP_HOOKS: 'prose-police,editor-police' } })).toBe('');
    expect(denied(runHook(WIKI_COMMIT, { extra: { AGENTKIT_SKIP_HOOKS: 'prose-police' } }))).toBe(true);
  });

  test('a configured repo with the tool missing refuses rather than allowing quietly', () => {
    const out = runHook(WIKI_COMMIT, { extra: { WIKI_EDITOR_BIN: join(root, 'no-such-tool') } });
    expect(denied(out)).toBe(true);
    expect(out).toContain('EDITOR TOOL MISSING');
  });
});

describe('editor-police: the one question, then the trailer', () => {
  beforeAll(() => {
    writeConfig(CONFIG);
    tool('clear', '--session', SESSION);
  });

  test('before the session has said who is editing, the refusal asks and names the known editors', () => {
    const out = runHook(WIKI_COMMIT);
    expect(denied(out)).toBe(true);
    expect(out).toContain('EDITOR UNKNOWN');
    expect(out).toContain('Ana Example, Bo Example, Other');
    expect(out).toContain(`wiki-editor set <name> --session ${SESSION}`);
  });

  test('another session is asked separately', () => {
    tool('set', 'ana', '--session', SESSION);
    expect(denied(runHook(WIKI_COMMIT, { session: 'someone-else' }))).toBe(true);
    expect(runHook(WIKI_COMMIT, { session: 'someone-else' })).toContain('EDITOR UNKNOWN');
  });

  test('once recorded, a commit without the trailer is refused with the exact trailer to add', () => {
    tool('set', 'ana', '--session', SESSION);
    const out = runHook(WIKI_COMMIT);
    expect(denied(out)).toBe(true);
    expect(out).toContain('EDITOR NOT ON THE COMMIT');
    expect(out).toContain(`--trailer=\\"${TRAILER}\\"`);
  });

  test('the remedy the refusal prints is accepted when replayed verbatim', () => {
    tool('set', 'ana', '--session', SESSION);
    const refusal = runHook(WIKI_COMMIT);
    const remedy = JSON.parse(refusal).hookSpecificOutput.permissionDecisionReason as string;
    const line = remedy.split('\n').find((l) => l.trim().startsWith('--trailer='));
    expect(line).toBeDefined();
    expect(runHook(`${WIKI_COMMIT} ${line!.trim()}`)).toBe('');
  });

  test('the unexpanded $(wiki-editor trailer …) form is accepted too', () => {
    tool('set', 'ana', '--session', SESSION);
    const cmd = `${WIKI_COMMIT} --trailer="$(wiki-editor trailer --session ${SESSION})"`;
    expect(runHook(cmd)).toBe('');
  });

  test("someone else's trailer is not this session's editor", () => {
    tool('set', 'ana', '--session', SESSION);
    const cmd = `${WIKI_COMMIT} --trailer="Edited-by: Bo Example <bo@example.com>"`;
    expect(denied(runHook(cmd))).toBe(true);
  });

  test('changing the editor mid-session changes the trailer the hook requires', () => {
    tool('set', 'ana', '--session', SESSION);
    expect(runHook(`${WIKI_COMMIT} --trailer="${TRAILER}"`)).toBe('');
    tool('set', 'BO', '--session', SESSION);
    expect(denied(runHook(`${WIKI_COMMIT} --trailer="${TRAILER}"`))).toBe(true);
    expect(runHook(`${WIKI_COMMIT} --trailer="Edited-by: Bo Example <bo@example.com>"`)).toBe('');
  });

  test('the author flag alone does not satisfy the gate, because a squash merge drops it', () => {
    tool('set', 'ana', '--session', SESSION);
    expect(denied(runHook(`${WIKI_COMMIT} --author="${ANA}"`))).toBe(true);
  });
});

describe('wiki-editor: the tool behind the gate', () => {
  beforeAll(() => {
    writeConfig(CONFIG);
    tool('clear', '--session', SESSION);
  });

  test('names lists the editors the config knows, in config order', () => {
    expect(tool('names').out.trim().split('\n')).toEqual(['Ana Example', 'Bo Example']);
  });

  test('a short name is matched case-insensitively and expands to the configured author', () => {
    for (const spelling of ['ana', 'Ana', 'ANA', '  ana ']) {
      tool('set', spelling, '--session', SESSION);
      expect(tool('author', '--session', SESSION).out.trim(), spelling).toBe(ANA);
    }
  });

  test('the full display name matches too', () => {
    tool('set', 'ana example', '--session', SESSION);
    expect(tool('author', '--session', SESSION).out.trim()).toBe(ANA);
  });

  test('a name the config does not know takes the fallback email', () => {
    tool('set', 'Cy Guest', '--session', SESSION);
    expect(tool('author', '--session', SESSION).out.trim()).toBe('Cy Guest <team@example.com>');
    expect(tool('trailer', '--session', SESSION).out.trim()).toBe('Edited-by: Cy Guest <team@example.com>');
  });

  test('an empty name is not recorded', () => {
    tool('clear', '--session', SESSION);
    expect(tool('set', '--session', SESSION).status).toBe(2);
    expect(tool('get', '--session', SESSION).status).toBe(1);
  });

  test('a session is required for any per-session verb', () => {
    expect(tool('set', 'ana').status).toBe(2);
    expect(tool('get').status).toBe(2);
  });

  test('clear forgets the editor so the question is asked again', () => {
    tool('set', 'ana', '--session', SESSION);
    tool('clear', '--session', SESSION);
    expect(tool('get', '--session', SESSION).status).toBe(1);
    expect(runHook(WIKI_COMMIT)).toContain('EDITOR UNKNOWN');
  });
});
