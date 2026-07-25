import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repoRoot = dirname(import.meta.dir);
const hook = join(repoRoot, 'hooks', 'claude', 'comment-police.sh');
const pluginHook = join(repoRoot, 'plugins-cc', 'agentkit', 'hooks', 'comment-police.sh');

function run(added: string, filePath = '/tmp/subject.ts', hookPath = hook): string {
  const payload = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: filePath, new_string: added },
  });
  const result = spawnSync('bash', [hookPath], { input: payload, encoding: 'utf-8' });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // Delivery is half the contract: Claude Code discards a PostToolUse hook's
  // stderr at exit 0, so a violation reported at 0 is one nobody hears. This
  // helper previously asserted 0 unconditionally, which pinned that bug.
  expect(result.status).toBe(out.includes('VIOLATION') ? 2 : 0);
  return out;
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

describe('police hooks reach the model', () => {
  // coding-police measures the file ON DISK; comment-police reads the added
  // string. Both need a real path, so each case writes its own subject.
  const cases = [
    { name: 'comment-police', hook: join(repoRoot, 'hooks', 'claude', 'comment-police.sh'),
      bad: `${'// filler comment line\n'.repeat(8)}const a = 1;\n` },
    { name: 'coding-police', hook: join(repoRoot, 'hooks', 'claude', 'coding-police.sh'),
      bad: 'const x = 1;\n'.repeat(1200) },
  ];
  const subject = join(tmpdir(), `agentkit-police-${process.pid}.ts`);

  // A PostToolUse hook that reports a violation at exit 0 has its stderr
  // discarded — it runs, finds the problem, and the model never learns of it.
  for (const c of cases) {
    test(`${c.name} exits 2 on a violation, so its stderr is delivered`, () => {
      writeFileSync(subject, c.bad);
      const payload = JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: subject, new_string: c.bad },
      });
      const r = spawnSync('bash', [c.hook], { input: payload, encoding: 'utf-8' });
      rmSync(subject, { force: true });
      expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('VIOLATION');
      expect(r.status).toBe(2);
    });

    test(`${c.name} stays silent and exits 0 on a clean edit`, () => {
      const clean = 'const a = 1;\nconst b = 2;\n';
      writeFileSync(subject, clean);
      const payload = JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: subject, new_string: clean },
      });
      const r = spawnSync('bash', [c.hook], { input: payload, encoding: 'utf-8' });
      rmSync(subject, { force: true });
      expect(r.status).toBe(0);
    });
  }

  test('the packaged plugin copy matches the canonical hook byte for byte', () => {
    // Two copies ship; a fix applied to one and not the other is a hook that
    // behaves differently depending on how agentkit was installed.
    for (const name of ['comment-police.sh', 'coding-police.sh', 'format-police.sh']) {
      const a = readFileSync(join(repoRoot, 'hooks', 'claude', name), 'utf-8');
      const b = readFileSync(join(repoRoot, 'plugins-cc', 'agentkit', 'hooks', name), 'utf-8');
      expect(b).toBe(a);
    }
  });
});

describe("blocking hooks have a way off and a bounded blast radius", () => {
  const hooks = ["comment-police", "coding-police", "format-police"];

  test("AGENTKIT_SKIP_HOOKS disables them", () => {
    // A blocking hook with no kill switch is one that gets deleted rather
    // than configured — and there is no PostToolUse loop guard to fall back on.
    const subject = join(tmpdir(), `agentkit-skip-${process.pid}.ts`);
    writeFileSync(subject, `${"// filler comment line\n".repeat(8)}const a = 1;\n`);
    const payload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: subject, new_string: `${"// filler comment line\n".repeat(8)}const a = 1;\n` },
    });
    for (const h of hooks) {
      const hook = join(repoRoot, "hooks", "claude", `${h}.sh`);
      for (const value of ["all", h]) {
        const r = spawnSync("bash", [hook], {
          input: payload,
          encoding: "utf-8",
          env: { ...process.env, AGENTKIT_SKIP_HOOKS: value },
        });
        expect(r.status, `${h} with AGENTKIT_SKIP_HOOKS=${value}`).toBe(0);
      }
    }
    rmSync(subject, { force: true });
  });

  test("a file that was ALREADY too long does not block every later edit", () => {
    // The wedge: coding-police measures whole-file state, so without this an
    // unrelated one-line edit to a big legacy file is unfixably blocked.
    const dir = mkdtempSync(join(tmpdir(), "agentkit-baseline-"));
    const file = join(dir, "big.ts");
    const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf-8" });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    // Distinct lines: a repeated line would trip the duplicate-code check
    // instead, and this test is about the LENGTH check alone.
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
    writeFileSync(file, lines(1200));
    git("add", "-A");
    git("commit", "-qm", "big file already exists");

    // Unchanged size: still over the limit, but not this edit's doing.
    writeFileSync(file, lines(1200));
    const r = spawnSync("bash", [join(repoRoot, "hooks", "claude", "coding-police.sh")], {
      input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file, new_string: "const x = 1;\n" } }),
      encoding: "utf-8",
    });
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).not.toContain("FILE TOO LONG");
    expect(r.status).toBe(0);

    // Growing it further IS this edit's doing, and must block.
    writeFileSync(file, lines(1400));
    const worse = spawnSync("bash", [join(repoRoot, "hooks", "claude", "coding-police.sh")], {
      input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file, new_string: "const x = 1;\n" } }),
      encoding: "utf-8",
    });
    expect(`${worse.stdout ?? ""}${worse.stderr ?? ""}`).toContain("FILE TOO LONG");
    expect(worse.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("AGENTKIT_SKIP_HOOKS tolerates spaces, matching version-police", () => {
    const subject = join(tmpdir(), `agentkit-skipws-${process.pid}.ts`);
    const bad = `${"// filler comment line\n".repeat(8)}const a = 1;\n`;
    writeFileSync(subject, bad);
    const payload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: subject, new_string: bad },
    });
    const hook = join(repoRoot, "hooks", "claude", "comment-police.sh");
    for (const value of [" all ", "coding-police, comment-police", "\tall"]) {
      const r = spawnSync("bash", [hook], {
        input: payload,
        encoding: "utf-8",
        env: { ...process.env, AGENTKIT_SKIP_HOOKS: value },
      });
      expect(r.status, `AGENTKIT_SKIP_HOOKS=${JSON.stringify(value)}`).toBe(0);
    }
    rmSync(subject, { force: true });
  });

  test("format-police does NOT block on a broken formatter install", () => {
    // dprint fetches wasm plugins over the network. An offline machine or one
    // bad config key must not turn every edit into an error nobody can fix.
    const dir = mkdtempSync(join(tmpdir(), "agentkit-fmtinfra-"));
    const bin = join(dir, "dprint");
    writeFileSync(bin, "#!/usr/bin/env bash\necho 'Error resolving plugin https://x/y.wasm: 404 Not Found' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, "dprint.json"), "{}");
    writeFileSync(join(dir, "clean.ts"), "const a = 1;\n");
    const r = spawnSync("bash", [join(repoRoot, "hooks", "claude", "format-police.sh")], {
      input: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(dir, "clean.ts"), new_string: "x" },
      }),
      encoding: "utf-8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      cwd: dir,
    });
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("format-police exits 2 when dprint actually fails", () => {
    // The surviving mutant: nothing tested format-police's exit at all.
    // A stub dprint that always fails makes this deterministic — asserting
    // "0 or 2" would pass whatever the hook did, which is the weakness this
    // whole review round was about.
    const dir = mkdtempSync(join(tmpdir(), "agentkit-fmt-"));
    const file = join(dir, "broken.ts");
    const bin = join(dir, "dprint");
    writeFileSync(bin, "#!/usr/bin/env bash\necho 'syntax error' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, "dprint.json"), "{}");
    writeFileSync(file, "const = = =;\n");
    const r = spawnSync("bash", [join(repoRoot, "hooks", "claude", "format-police.sh")], {
      input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file, new_string: "x" } }),
      encoding: "utf-8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      cwd: dir,
    });
    expect(`${r.stderr ?? ""}`).toContain("dprint fmt failed");
    expect(r.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
