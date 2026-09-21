import { afterAll, describe, test, expect, mock } from 'bun:test';
import { dirname, join } from 'node:path';
import gitPolice from '../plugins/git-police';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repoRoot = dirname(import.meta.dir);

const mockCtx = { client: {}, project: {}, directory: '/tmp', worktree: '/tmp', serverUrl: new URL('http://localhost'), $: {} } as any;

function makeInput(command: string) {
  return {
    input: { tool: 'bash', sessionID: 'test', callID: 'test' },
    output: { args: { command } },
  };
}

function readCodexGitPolicy() {
  return readFileSync(join(import.meta.dir, '..', 'policies/codex/git-police.rules'), 'utf-8');
}

describe('git-police', () => {
  describe('codex policy', () => {
    test('does not require interactive prompts', () => {
      expect(readCodexGitPolicy()).not.toContain('decision = "prompt"');
    });

    test('allows branch creation commands', () => {
      const policy = readCodexGitPolicy();
      expect(policy).toMatch(
        /pattern\s*=\s*\["git",\s*"checkout",\s*"-b"\],\s*decision\s*=\s*"allow"/,
      );
      expect(policy).toMatch(
        /pattern\s*=\s*\["git",\s*"switch",\s*"-c"\],\s*decision\s*=\s*"allow"/,
      );
    });
  });

  describe('blocks --no-verify', () => {
    const commands = [
      'git commit --no-verify -m "skip hooks"',
      'git push --no-verify',
      'git commit -m "fix" --no-verify',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('--no-verify');
      });
    }
  });

  describe('blocks force push', () => {
    const commands = [
      'git push --force origin feat/x',
      'git push -f origin feat/x',
      'git push --force-with-lease origin feat/x',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('Force push');
      });
    }
  });

  describe('blocks push to protected branches', () => {
    const commands = [
      'git push origin main',
      'git push origin master',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('protected branch');
      });
    }
  });

  describe('allows mirror-remote pushes of protected branches', () => {
    // Branch protection guards origin; a push that names a different remote
    // is a mirror sync of refs that already went through review there.
    const commands = [
      'git push up main',
      'git push up master',
      'git push -u mirror main',
      'git push up origin/main:refs/heads/main',
    ];

    for (const cmd of commands) {
      test(`allows: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
      });
    }
  });

  describe('blocks AI attribution trailers in commits', () => {
    const commands = [
      'git commit -m "fix stuff\n\nCo-authored-by: Claude <claude@anthropic.com>"',
      'git commit -m "fix\n\nCo-Authored-By: GPT"',
      'git commit -m "fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
      'git commit -m "fix\n\nGenerated with [Claude Code](https://claude.ai/code)"',
      'git commit -m "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd.substring(0, 60)}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('attribution');
      });
    }
  });

  describe('blocks AI attribution in forge content (MR/PR/issue)', () => {
    const commands = [
      'glab mr create --title "feat: x" --description "body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
      'glab mr update 42 --description "body\n\nGenerated with [Claude Code](https://claude.ai/code)"',
      'glab issue create --title "x" --description "🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
      'glab mr note 42 --message "done\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
      'gh pr create --title "x" --body "body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
      'gh pr comment 7 --body "Generated with [Claude Code](https://claude.ai/code)"',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd.substring(0, 60)}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('attribution');
      });
    }

    const allowed = [
      'glab mr create --title "feat: x" --description "a normal description with no attribution"',
      'gh pr create --title "x" --body "regular body"',
      'glab mr list --author @me',
    ];

    for (const cmd of allowed) {
      test(`allows: ${cmd.substring(0, 60)}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
      });
    }
  });

  describe('reads the commit message file, and tells a trailer from talk about one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-gp-ts-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const bad = join(dir, 'my msg');
    writeFileSync(bad, 'fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
    const blocked = [`git commit -F "${bad}"`, `git commit -qF'${bad}'`, `git commit --file="${bad}"`, 'git commit -F "$MSG"'];
    for (const cmd of blocked) {
      test(`blocks: ${cmd.replace(dir, '<tmp>')}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        await expect(hooks['tool.execute.before'](input, output)).rejects.toThrow('BLOCKED');
      });
    }
    test('allows a message that only mentions the trailer', async () => {
      const hooks = await gitPolice(mockCtx);
      const { input, output } = makeInput('git commit -m "chore: drop the co-authored-by trailer from the template"');
      await expect(hooks['tool.execute.before'](input, output)).resolves.toBeUndefined();
    });
  });

  describe('allowed-repos lifts branch protection and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-gp-allow-'));
    const repo = join(root, 'repo');
    const saved = process.env.XDG_CONFIG_HOME;
    mkdirSync(join(root, 'agentkit'), { recursive: true });
    writeFileSync(
      join(root, 'agentkit', 'config.yaml'),
      ['git-police:', '  branch-protection:', '    allowed-repos:', '      - someorg/allowed-repo', ''].join('\n'),
    );
    spawnSync('git', ['init', '-q', repo]);
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:someorg/allowed-repo.git']);
    afterAll(() => {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
      rmSync(root, { recursive: true, force: true });
    });
    const judge = async (cmd: string) => {
      process.env.XDG_CONFIG_HOME = root;
      const hooks = await gitPolice({ ...mockCtx, directory: repo });
      const { input, output } = makeInput(cmd);
      return hooks['tool.execute.before'](input, output);
    };
    test('a push to main is allowed', async () => {
      await expect(judge('git push origin main')).resolves.toBeUndefined();
    });
    for (const cmd of ['git commit -m "x\n\nCo-Authored-By: Claude <c@x>"', 'git push --force origin main', 'git commit --no-verify -m x']) {
      test(`still blocks: ${cmd.split('\n')[0]}`, async () => {
        await expect(judge(cmd)).rejects.toThrow('BLOCKED');
      });
    }
  });

  describe('stale branch protection (new branch commands)', () => {
    // These should be allowed because mockCtx.directory=/tmp has no git repo,
    // so getCurrentBranch returns null and the stale check is skipped
    const commands = [
      'git checkout -b feat/new-feature',
      'git switch -c feat/another-feature',
    ];

    for (const cmd of commands) {
      test(`allows when not on protected branch: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
      });
    }
  });

    describe('allows safe git operations', () => {
    const commands = [
      'git status',
      'git diff',
      'git log --oneline -10',
      'git push origin feat/my-branch',
      'git push -u origin feat/safety-plugins',
      'git checkout main',
      'git checkout -b feat/new-feature',
      'git switch main',
      'git branch -a',
      'git fetch origin',
      'git pull origin dev',
      'git stash',
      'git merge feat/x',
    ];

    for (const cmd of commands) {
      test(`allows: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
      });
    }
  });

  test('ignores non-bash tools', async () => {
    const hooks = await gitPolice(mockCtx);
    const input = { tool: 'edit', sessionID: 'test', callID: 'test' };
    const output = { args: { command: 'git push --force origin main' } };
    expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
  });
});

describe("git-police blocks attribution in the shell hook itself", () => {
  // The attribution tests above exercise the TypeScript hook. The bash hook is
  // what Claude Code actually runs, and its attribution rule piped a variable
  // that was never set into grep: under `set -u` the pipeline's subshell died,
  // grep read nothing, and the rule was false for every command. A heredoc
  // commit with a trailer walked straight through while every other rule held.
  // An empty config home, as below: a developer whose own agentkit config
  // allow-lists this repository would otherwise exit before any rule runs.
  const emptyConfig = mkdtempSync(join(tmpdir(), "agentkit-noconfig-"));
  afterAll(() => rmSync(emptyConfig, { recursive: true, force: true }));
  const run = (command: string) =>
    spawnSync("bash", [join(repoRoot, "hooks", "claude", "git-police.sh")], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, session_id: "t" }),
      encoding: "utf-8",
      env: { ...process.env, XDG_CONFIG_HOME: emptyConfig },
    });

  test("a heredoc commit carrying a trailer is denied", () => {
    const r = run(
      "cd /repo && git add -A && git commit -q -F - <<'EOF'\nfix(#1): x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF",
    );
    expect(`${r.stderr ?? ""}`).not.toContain("unbound variable");
    expect(`${r.stdout ?? ""}`).toContain('"permissionDecision": "deny"');
    expect(`${r.stdout ?? ""}`).toContain("attribution");
  });

  test("a forge write carrying a session link is denied", () => {
    const r = run('glab mr create --title "x" --description "done\n\nhttps://claude.ai/code/session_1"');
    expect(`${r.stdout ?? ""}`).toContain('"permissionDecision": "deny"');
  });

  test("a clean commit is allowed", () => {
    const r = run('git commit -m "fix(#1): x"');
    expect(`${r.stdout ?? ""}`).not.toContain("permissionDecision");
    expect(r.status).toBe(0);
  });
});

describe("git-police cannot be walked around", () => {
  // Each of these was a way past the attribution rule while it "worked": the
  // hook could not resolve the directory the command named, died with git's
  // exit 128, and the harness read a non-zero exit as a non-blocking error.
  const emptyConfig = mkdtempSync(join(tmpdir(), "agentkit-noconfig-"));
  const scratch = mkdtempSync(join(tmpdir(), "agentkit-gp-"));
  afterAll(() => {
    rmSync(emptyConfig, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });
  const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";
  const hook = join(repoRoot, "hooks", "claude", "git-police.sh");
  const run = (command: string, opts: { cwd?: string; env?: Record<string, string>; } = {}) => {
    const r = spawnSync("bash", [hook], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, session_id: "t" }),
      encoding: "utf-8",
      cwd: opts.cwd ?? repoRoot,
      env: { ...process.env, XDG_CONFIG_HOME: emptyConfig, ...opts.env },
    });
    return { denied: /"permissionDecision":\s*"deny"/.test(`${r.stdout ?? ""}`), out: `${r.stdout ?? ""}`, status: r.status };
  };

  test("a `cd $VAR` the hook cannot expand does not skip the rule", () => {
    const r = run(`W=/some/where; cd $W && git add -A && git commit -q -F - <<'EOF'\nfix: x\n\n${TRAILER}\nEOF\ngit push origin b`);
    expect(r.status).toBe(0);
    expect(r.denied).toBe(true);
  });

  test("a working directory that is not a repository does not skip the rule", () => {
    const r = run(`git commit -m "x\n\n${TRAILER}" && git push origin b`, { cwd: scratch });
    expect(r.status).toBe(0);
    expect(r.denied).toBe(true);
  });

  test("a clean commit and push from nowhere is judged, not crashed", () => {
    const r = run('cd $W && git commit -m "fix: x" && git push origin feat/x', { cwd: scratch });
    expect(r.status).toBe(0);
    expect(r.denied).toBe(false);
  });

  // The message can live in a file the agent wrote one tool call earlier.
  test("a trailer in the commit's message file is seen, in every spelling of -F", () => {
    const bad = join(scratch, "msg-bad");
    const ok = join(scratch, "msg-ok");
    writeFileSync(bad, `fix: x\n\n${TRAILER}\n`.replaceAll("\\n", "\n"));
    writeFileSync(ok, "fix: x\n\nplain body\n".replaceAll("\\n", "\n"));
    expect(run(`git commit -F ${bad}`).denied).toBe(true);
    expect(run(`git commit -qF '${bad}'`).denied).toBe(true);
    expect(run(`git commit --file=${bad}`).denied).toBe(true);
    expect(run(`git commit --file=${ok}`).denied).toBe(false);
  });

  test("the raw forge API is a forge write", () => {
    const body = "Fixes it\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)";
    expect(run(`glab api -X POST projects/1/merge_requests -f title=x -f description="${body}"`).denied).toBe(true);
    expect(run(`gh api repos/o/r/pulls -X POST -f title=x -f body="${body}"`).denied).toBe(true);
    // Reading the forge to look for attribution is an audit, not a write.
    expect(run('gh api repos/o/r/commits | grep -c "Co-Authored-By:"').denied).toBe(false);
  });

  test("tags, notes, merges and body files carry messages too", () => {
    const bad = join(scratch, "body-bad");
    writeFileSync(bad, `Summary\n\n${TRAILER}\n`);
    expect(run(`git tag -a v1 -m "v1\n\n${TRAILER}"`).denied).toBe(true);
    expect(run(`git notes add -m "${TRAILER}"`).denied).toBe(true);
    expect(run(`gh pr merge 5 --squash --body "x\n\n${TRAILER}"`).denied).toBe(true);
    expect(run(`gh pr create --title x --body-file ${bad}`).denied).toBe(true);
    expect(run(`gh issue comment 5 -F ${bad}`).denied).toBe(true);
    expect(run("git tag -a v1 -m v1").denied).toBe(false);
  });

  test("a PATH without grep is reported, not passed in silence", () => {
    const bin = join(scratch, "nogrep");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["bash", "jq", "sed", "cat"]) {
      const real = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
      if (real) symlinkSync(real, join(bin, tool));
    }
    const r = spawnSync(join(bin, "bash"), [hook], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `git commit -m "${TRAILER}"` } }),
      encoding: "utf-8",
      env: { PATH: bin, HOME: emptyConfig, XDG_CONFIG_HOME: emptyConfig },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNCHECKED: git-police failed");
  });

  test("talking about the trailer is allowed; writing one is not", () => {
    expect(run('git commit -m "chore: remove the co-authored-by trailer from the template"').denied).toBe(false);
    expect(run('git commit -m x --trailer "Co-authored-by=Claude <c@x>"').denied).toBe(true);
    expect(run(`git commit -m "x\n\n${TRAILER}"`).denied).toBe(true);
  });

  // The backstop for the next crash nobody has found yet.
  test("a git that always fails neither blocks a clean commit nor frees an attributed one", () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 128\n".replaceAll("\\n", "\n"), { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const clean = run('git commit -m "fix: x" && git push origin feat/x', { env });
    expect(clean.status).toBe(0);
    expect(clean.denied).toBe(false);
    expect(run(`git commit -m "x\n\n${TRAILER}"`, { env }).denied).toBe(true);
  });

  test("a hook that dies refuses what it exists to judge instead of exiting non-zero", () => {
    // jq missing from PATH kills the payload read; without the exit trap that
    // is a silent non-zero exit, which the harness treats as allow.
    const bin = join(scratch, "nojq");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "jq"), "#!/bin/sh\nexit 3\n".replaceAll("\\n", "\n"), { mode: 0o755 });
    const r = run(`git commit -m "x\n\n${TRAILER}"`, { env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status).toBe(0);
    // The command was never read, so there is nothing to refuse: it says so.
    expect(r.out).toContain("UNCHECKED: git-police failed");
    expect(JSON.parse(r.out).hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  // BSD sed rejected the lazy quantifier in the repo-name extraction, so on
  // macOS the name was always empty and the allow-list never matched.
  test("an allow-listed repository is recognised on this platform's sed", () => {
    const repo = join(scratch, "repo");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"]);
    spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:someorg/allowed-repo.git"]);
    const config = join(scratch, "config");
    mkdirSync(join(config, "agentkit"), { recursive: true });
    writeFileSync(
      join(config, "agentkit", "config.yaml"),
      ["git-police:", "  branch-protection:", "    allowed-repos:", "      - someorg/allowed-repo", ""].join("\n").replaceAll("\\n", "\n"),
    );
    const env = { XDG_CONFIG_HOME: config };
    const pushMain = `git -C ${repo} push origin main`;
    expect(run(pushMain, { env }).denied).toBe(false);
    expect(run(pushMain).denied).toBe(true);

    // The exemption is branch protection, and nothing else.
    expect(run(`git -C ${repo} commit -m "x\n\n${TRAILER}"`, { env }).denied).toBe(true);
    expect(run(`git -C ${repo} push --force origin main`, { env }).denied).toBe(true);
    expect(run(`git -C ${repo} commit --no-verify -m x`, { env }).denied).toBe(true);

    // An allow-listed cwd does not vouch for a repository the hook cannot see.
    expect(run("git -C $ELSEWHERE push origin main", { env, cwd: repo }).denied).toBe(true);
  });

  test("every message file is read, however -F is spelled", () => {
    const dir = join(scratch, "with space");
    mkdirSync(dir, { recursive: true });
    const spaced = join(dir, "my msg");
    const bad = join(scratch, "msg-bad-2");
    const ok = join(scratch, "msg-ok-2");
    for (const f of [spaced, bad]) writeFileSync(f, `fix: x\n\n${TRAILER}\n`);
    writeFileSync(ok, "fix: x\n");
    expect(run(`git commit -F${bad}`).denied).toBe(true);
    expect(run(`git commit -F "${spaced}"`).denied).toBe(true);
    expect(run(`git commit -F ${bad} -F ${ok}`).denied).toBe(true);
    expect(run(`git commit -F ${bad} && git log --grep -F x`).denied).toBe(true);
    // A -F that belongs to an earlier command is not a message file.
    expect(run(`grep -F ${bad} /dev/null; git commit -m "fix: x"`).denied).toBe(false);
  });

  test("a -F that belongs to the next command in the chain is not a message file", () => {
    const chained = [
      'git commit -m "fix: x" && grep -F "$pattern" src/app.ts',
      'git commit -m "fix; still one message" && docker compose --file "$COMPOSE_FILE" up -d',
      'git commit -m "fix: x" && curl -F "file=@$P" https://x/y',
      'git tag -l | grep -F "$v"',
      'git notes show HEAD && grep -F "$n" f',
    ];
    for (const cmd of chained) expect(run(cmd).denied).toBe(false);
    // A second commit in the chain is still a commit.
    const bad = join(scratch, "msg-bad-3");
    writeFileSync(bad, `fix: x\n\n${TRAILER}\n`);
    expect(run(`git commit -m "a; b" -F ${bad}`).denied).toBe(true);
    expect(run(`git commit -m ok && git commit --amend -F ${bad}`).denied).toBe(true);
  });

  test("an unset HOME is not a silent exit", () => {
    const env: Record<string, string> = { ...process.env, XDG_CONFIG_HOME: emptyConfig } as Record<string, string>;
    delete env.HOME;
    const r = spawnSync("bash", [hook], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `git commit -m "x\n\n${TRAILER}"` } }),
      encoding: "utf-8",
      cwd: repoRoot,
      env,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/"permissionDecision":\s*"deny"/);
    delete env.XDG_CONFIG_HOME;
    const bare = spawnSync("bash", [hook], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `git commit -m "x\n\n${TRAILER}"` } }),
      encoding: "utf-8",
      cwd: repoRoot,
      env,
    });
    expect(bare.stdout).toMatch(/"permissionDecision":\s*"deny"/);
  });

  test("a message file the hook cannot read is refused, and says why", () => {
    const r = run('git commit -F "$MSG"');
    expect(r.denied).toBe(true);
    expect(r.out).toContain("Pass the literal path");
  });

  test("a refusal built on a guessed repository says it was a guess", () => {
    const onMain = join(scratch, "on-main");
    mkdirSync(onMain, { recursive: true });
    spawnSync("git", ["-C", onMain, "init", "-q", "-b", "main"]);
    const r = run('cd $W && git commit -m "fix: x"', { cwd: onMain });
    expect(r.denied).toBe(true);
    expect(r.out).toContain("could not resolve the directory this command names");
    expect(run('git commit -m "fix: x"', { cwd: onMain }).out).not.toContain("could not resolve");
  });

  test("a crash after the command is read refuses it, in JSON the harness can parse", () => {
    const bin = join(scratch, "noawk");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "awk"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const r = run('git commit -m "fix: x" && git push origin feat/x', { env });
    expect(r.status).toBe(0);
    expect(r.denied).toBe(true);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason).toContain("git-police failed");
    const other = run("ls -la", { env });
    expect(other.status).toBe(0);
    expect(other.denied).toBe(false);
  });
});

describe("git-police works on a stock install", () => {
  test("a force push is denied with no agentkit config present", () => {
    // `[[ -f $CONFIG ]] || return` propagated status 1 into `set -e`, so the
    // hook exited 1 with ZERO output before any guard ran — and a hook that
    // emits no decision is read as ALLOW. Every protection in it was off for
    // anyone who had never written a config file.
    const empty = mkdtempSync(join(tmpdir(), "agentkit-noconfig-"));
    const r = spawnSync("bash", [join(repoRoot, "hooks", "claude", "git-police.sh")], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main" },
        session_id: "t",
      }),
      encoding: "utf-8",
      env: { ...process.env, XDG_CONFIG_HOME: empty },
    });
    expect(`${r.stdout ?? ""}`).toContain('"permissionDecision": "deny"');
    // ...and only the right things: a hook that denied everything would also
    // satisfy the assertion above.
    const benign = spawnSync("bash", [join(repoRoot, "hooks", "claude", "git-police.sh")], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git status" },
        session_id: "t",
      }),
      encoding: "utf-8",
      env: { ...process.env, XDG_CONFIG_HOME: empty },
    });
    expect(`${benign.stdout ?? ""}`).not.toContain("permissionDecision");
    expect(benign.status).toBe(0);
    rmSync(empty, { recursive: true, force: true });
  });
});
