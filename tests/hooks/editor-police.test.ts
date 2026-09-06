import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  test('enabled: false allows a commit in a listed repo, however it is spelled', () => {
    for (const off of ['false', 'false  # switched off for now', '"false"', "'no'", 'off', 'No', '0']) {
      writeConfig(`editor-police:\n  enabled: ${off}\n  repos:\n    - myorg/*/wiki\n`);
      expect(runHook(WIKI_COMMIT), off).toBe('');
    }
  });

  test('a trailing comment on the section header does not hide the section', () => {
    writeConfig('editor-police:  # shared eda session\n  enabled: true\n  repos:\n    - myorg/*/wiki\n');
    expect(denied(runHook(WIKI_COMMIT))).toBe(true);
  });

  test('a flow-style repos list is read', () => {
    writeConfig('editor-police:\n  enabled: true\n  repos: ["myorg/*/wiki", myorg/handbook]  # both\n');
    expect(denied(runHook(WIKI_COMMIT))).toBe(true);
    expect(denied(runHook('git -C /srv/myorg/handbook commit -m x'))).toBe(true);
    expect(runHook('git -C /srv/myorg/other commit -m x')).toBe('');
  });

  test('an empty or commented-out list item does not switch the guard off', () => {
    for (const cfg of [
      'editor-police:\n  enabled: true\n  repos:\n    - myorg/*/wiki\n    - \n',
      'editor-police:\n  enabled: true\n  repos:\n    - myorg/*/wiki\n    - # note\n',
      'editor-police:\n  enabled: true\n  repos: [myorg/*/wiki, ]\n',
    ]) {
      writeConfig(cfg);
      expect(denied(runHook(WIKI_COMMIT)), cfg).toBe(true);
      expect(runHook('git -C /srv/other/app commit -m x'), cfg).toBe('');
    }
  });

  test('a quoted or commented list item is read', () => {
    writeConfig('editor-police:\n  enabled: true\n  repos:\n    - "myorg/*/wiki"  # the wikis\n');
    expect(denied(runHook(WIKI_COMMIT))).toBe(true);
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
    expect(denied(runHook('git -c core.quotepath=off -C /srv/myorg/docs/wiki commit -m x'))).toBe(true);
    expect(denied(runHook('git --no-pager -C /srv/myorg/docs/wiki commit -m x'))).toBe(true);
    expect(denied(runHook('git --git-dir=/srv/myorg/docs/wiki/.git commit -m x'))).toBe(true);
    expect(denied(runHook('git -C /srv/myorg/handbook commit -m x'))).toBe(true);
    expect(denied(runHook('cd /srv/myorg/docs/wiki && git commit -am x'))).toBe(true);
  });

  test('a commit whose working directory is inside a matching repo is refused', () => {
    const cwd = join(root, 'myorg', 'docs', 'wiki', 'pages');
    mkdirSync(cwd, { recursive: true });
    expect(denied(runHook('git commit -m x', { cwd }))).toBe(true);
  });

  test('every way of naming the repo on the command line is resolved, whatever follows the path', () => {
    for (const cmd of [
      'cd /srv/myorg/docs/wiki; git commit -m x',
      'cd /srv/myorg/docs/wiki && git commit -m x',
      'cd /srv/myorg/docs/wiki || exit 1; git commit -m x',
      "git -C '/srv/myorg/docs/wiki' commit -m x",
      'git -C "/srv/myorg/docs/wiki" commit -m x',
      '(cd /srv/myorg/docs/wiki; git commit -m x)',
      'git -C /srv/myorg/docs/wiki commit -m x | cat',
      'git -C /srv/myorg/docs/wiki add -A && git -C /srv/myorg/docs/wiki commit -m x',
      'git --git-dir=/srv/myorg/docs/wiki/.git commit -m x',
      'git -C/srv/myorg/docs/wiki commit -m x',
      'env GIT_AUTHOR_DATE=now git -C /srv/myorg/docs/wiki commit -m x',
      'cd /srv/myorg/docs/wiki && git add -A && git commit -m x &',
      'git -C /srv/myorg/docs/wiki commit -m "a; b && c | d" ',
      'git -C /srv/myorg/docs/wiki commit -m x\ngit -C /srv/elsewhere/app push',
    ]) {
      expect(denied(runHook(cmd)), cmd).toBe(true);
    }
  });

  test('cd moves the working directory for the segments after it, relatively too', () => {
    const base = join(root, 'myorg', 'docs');
    mkdirSync(join(base, 'wiki'), { recursive: true });
    expect(denied(runHook('cd wiki && git commit -m x', { cwd: base }))).toBe(true);
    expect(denied(runHook('cd wiki; cd ..; git commit -m x', { cwd: base }))).toBe(false);
    expect(denied(runHook(`cd ${join(base, 'wiki')}/pages 2>/dev/null; git commit -m x`, { cwd: root }))).toBe(true);
  });

  test('a configured path mentioned inside a quoted string is not the target repo', () => {
    for (const cmd of [
      'git -C /srv/elsewhere/app commit -m "sync content from /srv/myorg/docs/wiki/"',
      'git -C /srv/elsewhere/app commit -F /srv/myorg/docs/wiki/msg.txt',
      "git -C /srv/elsewhere/app commit -m 'see myorg/docs/wiki'",
    ]) {
      expect(runHook(cmd), cmd).toBe('');
    }
  });

  test('a quote earlier in the command does not hide the commit from the gate', () => {
    for (const cmd of [
      `sed -i 's/x/"/' page.md && git -C /srv/myorg/docs/wiki commit -am "docs: fix quote"`,
      'bash -c "git -C /srv/myorg/docs/wiki commit -m x"',
      "sh -c 'git -C /srv/myorg/docs/wiki commit -m x'",
      'eval "git -C /srv/myorg/docs/wiki commit -m x"',
    ]) {
      expect(denied(runHook(cmd)), cmd).toBe(true);
    }
  });

  test('a linked worktree of a configured repo is judged like the clone', () => {
    const clone = join(root, 'myorg', 'docs', 'wiki');
    const wt = join(root, 'scratch', 'wiki-edit');
    mkdirSync(clone, { recursive: true });
    const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf-8' });
    git('-C', clone, 'init', '-q', '-b', 'main');
    git('-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('-C', clone, 'worktree', 'add', '-q', wt, '-b', 'edit');
    expect(denied(runHook('git commit -m x', { cwd: wt }))).toBe(true);
    expect(denied(runHook('git commit -m x', { cwd: join(clone) }))).toBe(true);
    expect(runHook('git -C /srv/other/app commit -m x', { cwd: wt })).toBe('');
  });

  test('a command with unbalanced quotes is allowed, because bash refuses it before any commit happens', () => {
    expect(runHook('git -C /srv/myorg/docs/wiki commit -m "unterminated')).toBe('');
    expect(runHook("git -C /srv/myorg/docs/wiki commit -m 'unterminated")).toBe('');
  });

  test('a comment is not code: an apostrophe in it does not hide the commit after it', () => {
    tool('set', 'ana', '--session', SESSION);
    const cwd = join(root, 'myorg', 'docs', 'wiki');
    mkdirSync(cwd, { recursive: true });
    const cmds = [
      "# don't forget the changelog\ngit add -A\ngit commit -m \"update wiki page\"",
      "# the wiki's changelog\ngit commit -am x",
      "echo \"done\"   # it's fine\ngit commit -am x",
      "# see <<EOF in the docs\ngit commit -am x",
      "git add -A # stage it's all\ngit commit -am x",
    ];
    for (const cmd of cmds) expect(denied(runHook(cmd, { cwd })), cmd).toBe(true);
    for (const cmd of cmds) expect(runHook(`${cmd} --trailer="${TRAILER}"`, { cwd }), cmd).toBe('');
    expect(runHook('echo a#b; git commit -m x', { cwd })).toContain('deny');
    expect(runHook('echo "#" ; git -C /srv/other/app commit -m x', { cwd })).toBe('');
  });

  test('a here-string is one word, not a heredoc body', () => {
    tool('set', 'ana', '--session', SESSION);
    const cwd = join(root, 'myorg', 'docs', 'wiki');
    mkdirSync(cwd, { recursive: true });
    expect(denied(runHook('cat <<< "here string"\ngit commit -m x', { cwd }))).toBe(true);
    expect(denied(runHook('git commit -m x <<< "input"', { cwd }))).toBe(true);
    expect(runHook(`cat <<< "here string"\ngit commit -m x --trailer="${TRAILER}"`, { cwd })).toBe('');
  });

  test('a long command that mentions commit early is judged every time', () => {
    tool('set', 'ana', '--session', SESSION);
    const cwd = join(root, 'myorg', 'docs', 'wiki');
    mkdirSync(cwd, { recursive: true });
    const body = 'x'.repeat(150000);
    const cmd = `echo "about to commit the wiki update"\ncat > page.md <<'EOF'\n${body}\nEOF\ngit add -A\ngit commit -m "update page"`;
    for (let i = 0; i < 5; i++) expect(denied(runHook(cmd, { cwd })), `run ${i}`).toBe(true);
    expect(runHook(`${cmd} --trailer="${TRAILER}"`, { cwd })).toBe('');
  });

  test('popd returns to the directory pushd left', () => {
    tool('set', 'ana', '--session', SESSION);
    expect(runHook('pushd /srv/myorg/docs/wiki; popd; git commit -m x', { cwd: root })).toBe('');
    expect(denied(runHook('pushd /srv/myorg/docs/wiki; popd; pushd /srv/myorg/docs/wiki; git commit -m x', { cwd: root }))).toBe(true);
  });

  test('a heredoc body is data: apostrophes in it do not hide the commit after it', () => {
    tool('set', 'ana', '--session', SESSION);
    const cwd = join(root, 'myorg', 'docs', 'wiki');
    mkdirSync(cwd, { recursive: true });
    const cmds = [
      "cat > page.md <<'EOF'\nIt's the operator's job. Don't skip step 2.\nEOF\ngit add -A && git commit -m \"docs: runbook\"",
      'cat > page.md <<EOF\nOne " stray quote\nEOF\ngit commit -am "docs: runbook"',
      "cat > a.md <<'A'\nit's\nA\ncat > b.md <<'B'\ndon't\nB\ngit commit -am x",
      "cat > page.md <<-'EOF'\n\tIt's indented\n\tEOF\ngit commit -am x",
    ];
    for (const cmd of cmds) expect(denied(runHook(cmd, { cwd })), cmd).toBe(true);
    for (const cmd of cmds) expect(runHook(`${cmd} --trailer="${TRAILER}"`, { cwd }), cmd).toBe('');
    const stdin = "git commit -F - <<'EOF'\ndocs: it's a runbook\n\nDon't skip step 2\nEOF";
    expect(denied(runHook(stdin, { cwd }))).toBe(true);
    expect(runHook(stdin.replace('git commit', `git commit --trailer="${TRAILER}"`), { cwd })).toBe('');
    expect(runHook("cat > page.md <<'EOF'\nIt's fine\nEOF\ngit -C /srv/other/app commit -m x", { cwd })).toBe('');
  });

  test('combined shell flags, timeout, pushd and cd - are followed', () => {
    tool('set', 'ana', '--session', SESSION);
    const wiki = '/srv/myorg/docs/wiki';
    for (const cmd of [
      `bash -lc "git -C ${wiki} commit -m x"`,
      `bash -xec "git -C ${wiki} commit -m x"`,
      `timeout 30 git -C ${wiki} commit -m x`,
      `timeout 5m nice -n 10 git -C ${wiki} commit -m x`,
      `pushd ${wiki}; git commit -m x`,
      `cd ${wiki}; cd /tmp; cd -; git commit -m x`,
    ]) {
      expect(denied(runHook(cmd)), cmd).toBe(true);
    }
    expect(runHook(`cd ${wiki}; cd -; git commit -m x`, { cwd: root })).toBe('');
  });

  test('a missing awk refuses with a reason instead of allowing quietly', () => {
    const bin = join(root, 'noawk');
    mkdirSync(bin, { recursive: true });
    for (const b of ['bash', 'sed', 'grep', 'tr', 'paste', 'head', 'cat', 'git', 'jq', 'dirname', 'basename', 'mkdir', 'env']) {
      const found = spawnSync('bash', ['-c', `command -v ${b}`], { encoding: 'utf-8' }).stdout.trim();
      if (found) try { symlinkSync(found, join(bin, b)); } catch {}
    }
    const out = runHook(WIKI_COMMIT, { extra: { PATH: bin } });
    expect(denied(out)).toBe(true);
    expect(out).toContain('UNCHECKED');
    expect(runHook('git -C /srv/other/app status', { extra: { PATH: bin } })).toBe('');
  });

  test('ordinary multi-line and escaped commit messages are never the reason for a refusal', () => {
    const multi = 'git -C /srv/elsewhere/app commit -m "feat: thing\n\nCloses #1"';
    const heredoc = "git -C /srv/elsewhere/app commit -m \"$(cat <<'EOF'\nfeat: thing\n\nbody; with && bars | too\nEOF\n)\"";
    const escaped = 'git -C /srv/elsewhere/app commit -m "fix \\"foo\\" handling"';
    for (const cmd of [multi, heredoc, escaped]) expect(runHook(cmd), cmd).toBe('');
    rmSync(join(configDir, 'agentkit'), { force: true, recursive: true });
    for (const cmd of [multi, heredoc, escaped, multi.replace('/srv/elsewhere/app', '/srv/myorg/docs/wiki')]) expect(runHook(cmd), cmd).toBe('');
    writeConfig(CONFIG);
  });

  test('a multi-line message in a configured repo is judged on its trailer like any other', () => {
    tool('set', 'ana', '--session', SESSION);
    const multi = 'git -C /srv/myorg/docs/wiki commit -m "feat: thing\n\nCloses #1; also && more | stuff"';
    expect(denied(runHook(multi))).toBe(true);
    expect(runHook(`${multi} --trailer="${TRAILER}"`)).toBe('');
    expect(runHook(`git -C /srv/myorg/docs/wiki commit --trailer="${TRAILER}" -m "$(cat <<'EOF'\nfeat: thing\nEOF\n)"`)).toBe('');
  });

  test('a very large commit command is still judged, quickly', () => {
    tool('set', 'ana', '--session', SESSION);
    const big = `git -C /srv/myorg/docs/wiki commit -m "${'a'.repeat(60000)}"`;
    const started = Date.now();
    expect(denied(runHook(big))).toBe(true);
    expect(runHook(`${big} --trailer="${TRAILER}"`)).toBe('');
    expect(Date.now() - started).toBeLessThan(4000);
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
      'echo "run git commit later" > /srv/myorg/docs/wiki/notes.txt',
      "echo 'git -C /srv/myorg/docs/wiki commit -m x' > /srv/myorg/docs/wiki/notes.txt",
      'echo run git -C /srv/myorg/docs/wiki commit later',
      'sudo -u someone git -C /srv/myorg/docs/wiki status',
      'git -C /srv/myorg/docs/wiki config commit.gpgsign true',
    ]) {
      expect(runHook(cmd), cmd).toBe('');
    }
  });

  test('AGENTKIT_SKIP_HOOKS=editor-police switches it off for the session', () => {
    expect(runHook(WIKI_COMMIT, { extra: { AGENTKIT_SKIP_HOOKS: 'editor-police' } })).toBe('');
    expect(runHook(WIKI_COMMIT, { extra: { AGENTKIT_SKIP_HOOKS: 'prose-police,editor-police' } })).toBe('');
    expect(runHook(WIKI_COMMIT, { extra: { AGENTKIT_SKIP_HOOKS: 'prose-police, editor-police' } })).toBe('');
    expect(runHook(WIKI_COMMIT, { extra: { AGENTKIT_SKIP_HOOKS: 'all' } })).toBe('');
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

  test('the unexpanded $(wiki-editor trailer …) form is refused, because off PATH it substitutes to nothing', () => {
    tool('set', 'ana', '--session', SESSION);
    const cmd = `${WIKI_COMMIT} --trailer="$(wiki-editor trailer --session ${SESSION})"`;
    expect(denied(runHook(cmd))).toBe(true);
  });

  test('every quoting of the trailer that git accepts is accepted', () => {
    tool('set', 'ana', '--session', SESSION);
    for (const form of [`--trailer="${TRAILER}"`, `--trailer='${TRAILER}'`, `--trailer "${TRAILER}"`, `--trailer '${TRAILER}'`]) {
      expect(runHook(`${WIKI_COMMIT} ${form}`), form).toBe('');
    }
  });

  test('set prints the trailer to copy, and the hook accepts exactly that', () => {
    const printed = tool('set', 'ana', '--session', SESSION).out.split('\n').find((l) => l.startsWith('commit with: '));
    expect(printed).toBeDefined();
    expect(runHook(`${WIKI_COMMIT} ${printed!.replace('commit with: ', '')}`)).toBe('');
  });

  test('the trailer must be on the wiki commit itself, not elsewhere in a compound command', () => {
    tool('set', 'ana', '--session', SESSION);
    const other = `git -C /srv/elsewhere/app commit -m y --trailer="${TRAILER}"`;
    expect(denied(runHook(`${WIKI_COMMIT} && ${other}`))).toBe(true);
    expect(denied(runHook(`${WIKI_COMMIT} && ${WIKI_COMMIT} --trailer="${TRAILER}"`))).toBe(true);
    expect(runHook(`${WIKI_COMMIT} --trailer="${TRAILER}" && ${WIKI_COMMIT} --trailer="${TRAILER}"`)).toBe('');
    expect(runHook(`${other} && ${WIKI_COMMIT} --trailer="${TRAILER}"`)).toBe('');
  });

  test('the trailer as prose inside the commit message is not a trailer', () => {
    tool('set', 'ana', '--session', SESSION);
    expect(denied(runHook(`${WIKI_COMMIT.replace('-m "docs: update"', '')} -m 'docs: explain --trailer="${TRAILER}"'`))).toBe(true);
  });

  test('an empty --trailer= is not a trailer', () => {
    tool('set', 'ana', '--session', SESSION);
    expect(denied(runHook(`${WIKI_COMMIT} --trailer=""`))).toBe(true);
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

  test('a commented section header still yields the editors and the fallback', () => {
    writeConfig(`editor-police:  # shared session\n  editors:\n    ana: "${ANA}"\n  fallback-email: team@example.com\n`);
    tool('set', 'ANA', '--session', SESSION);
    expect(tool('author', '--session', SESSION).out.trim()).toBe(ANA);
    tool('set', 'Cy Guest', '--session', SESSION);
    expect(tool('author', '--session', SESSION).out.trim()).toBe('Cy Guest <team@example.com>');
    writeConfig(CONFIG);
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
