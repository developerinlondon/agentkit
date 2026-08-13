import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    for (const name of ['comment-police.sh', 'coding-police.sh', 'format-police.sh', 'issue-police.sh']) {
      const a = readFileSync(join(repoRoot, 'hooks', 'claude', name), 'utf-8');
      const b = readFileSync(join(repoRoot, 'plugins-cc', 'agentkit', 'hooks', name), 'utf-8');
      expect(b).toBe(a);
    }
  });
});

describe("the hooks run on the bash the target platform actually ships", () => {
  // stock macOS is bash 3.2. Two constructs die there and both are fatal:
  // `"${arr[@]}"` on an EMPTY array is an unbound-variable error under `set -u`
  // (not fixed until bash 4.4), and `(` inside [[ =~ ]] is a PARSE error. For a
  // PreToolUse Bash hook a parse error denies EVERY command, and the kill
  // switch is unreachable because the script never starts.
  const hookDir = join(repoRoot, "hooks", "claude");
  const shells = readdirSync(hookDir).filter((f) => f.endsWith(".sh"));

  // The real check, when a 3.2 is available: it subsumes both spelling proxies
  // below, which pin how the rules are WRITTEN rather than that they hold.
  const bash32 = [
    process.env.AGENTKIT_BASH32,
    "/usr/local/bin/bash-3.2",
    join(tmpdir(), "bash-3.2", "bash"),
  ].find((p) => p && existsSync(p));

  test.skipIf(!bash32)("every hook parses under real bash 3.2", () => {
    const offenders: string[] = [];
    for (const name of shells) {
      const r = spawnSync(bash32!, ["-n", join(hookDir, name)], { encoding: "utf-8" });
      if (r.status !== 0) offenders.push(`${name}: ${(r.stderr ?? "").split("\n")[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  test("every possibly-empty array expansion uses the +expansion guard", () => {
    // CONFIG_FLAG is exempt: every branch assigns two elements or exits first.
    const exempt = new Set(["CONFIG_FLAG"]);
    const offenders: string[] = [];
    for (const name of shells) {
      readFileSync(join(hookDir, name), "utf-8").split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/"\$\{([A-Z_]+)\[@\]\}"/g)) {
          if (exempt.has(m[1])) continue;
          if (line.includes(`\${${m[1]}[@]+`)) continue;
          offenders.push(`${name}:${i + 1} ${m[1]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("no [[ =~ ]] pattern contains an unquoted group", () => {
    const offenders: string[] = [];
    for (const name of shells) {
      readFileSync(join(hookDir, name), "utf-8").split("\n").forEach((line, i) => {
        const at = line.indexOf("=~");
        if (at < 0) return;
        // A character class can contain ], so stopping at the first ] misses
        // the group entirely — which is how this assertion first failed to fail.
        const end = line.lastIndexOf("]]");
        const pattern = end > at ? line.slice(at + 2, end) : line.slice(at + 2);
        if (/(^|[^\\])\(/.test(pattern)) offenders.push(`${name}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
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

  test("format-police does NOT block on infrastructure failures", () => {
    // dprint fetches wasm plugins over the network, and a repo's `includes`
    // may not cover this extension at all. Neither is something the model can
    // act on, so neither may block. agentkit's OWN dprint.json omits .ts —
    // blocking on that would have made this repo un-editable.
    const cases = [
      "Error resolving plugin https://x/y.wasm: 404 Not Found",
      "No files found to format with the specified plugins",
      "error sending request for url (https://plugins.dprint.dev/x.wasm)",
    ];
    for (const stderr of cases) {
      const dir = mkdtempSync(join(tmpdir(), "agentkit-fmtinfra-"));
      const bin = join(dir, "dprint");
      writeFileSync(bin, `#!/usr/bin/env bash\necho ${JSON.stringify(stderr)} >&2\nexit 1\n`);
      chmodSync(bin, 0o755);
      writeFileSync(join(dir, "dprint.json"), "{}");
      const file = join(dir, "clean.ts");
      writeFileSync(file, "const a = 1;\n");
      const r = spawnSync("bash", [join(repoRoot, "hooks", "claude", "format-police.sh")], {
        input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file, new_string: "x" } }),
        encoding: "utf-8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
        cwd: dir,
      });
      expect(r.status, stderr).toBe(0);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a real edit to a .ts file in THIS repo does not error", () => {
    // The regression that would have shipped: agentkit's dprint.json covers
    // md/json/toml/yaml only, so dprint reports "no files found" for every .ts
    // — and blocking on that makes the repo un-editable.
    const r = spawnSync("bash", [join(repoRoot, "hooks", "claude", "format-police.sh")], {
      input: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(repoRoot, "plugins", "comment-police.ts"), new_string: "x" },
      }),
      encoding: "utf-8",
      cwd: repoRoot,
    });
    expect(r.status, `${r.stdout ?? ""}${r.stderr ?? ""}`).toBe(0);
  });

  test("format-police exits 2 when dprint actually fails", () => {
    // The surviving mutant: nothing tested format-police's exit at all.
    // A stub dprint that always fails makes this deterministic — asserting
    // "0 or 2" would pass whatever the hook did, which is the weakness this
    // whole review round was about.
    const dir = mkdtempSync(join(tmpdir(), "agentkit-fmt-"));
    const file = join(dir, "broken.ts");
    const bin = join(dir, "dprint");
    // dprint's own attributable wording — the allowlisted signal.
    writeFileSync(
      bin,
      `#!/usr/bin/env bash\necho "Error formatting $4: Unexpected token" >&2\nexit 1\n`,
    );
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

describe("coding-police reports what the EDIT did, not what the file already was", () => {
  // The subtraction pass had no coverage: narrowing it back to file-length
  // only — reintroducing the bug it was written for — passed the whole suite.
  function legacyRepo(): { dir: string; file: string; git: (...a: string[]) => void; } {
    const dir = mkdtempSync(join(tmpdir(), "agentkit-sub-"));
    const file = join(dir, "legacy.ts");
    const git = (...a: string[]) => {
      spawnSync("git", a, { cwd: dir, encoding: "utf-8" });
    };
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    return { dir, file, git };
  }
  const longFn = (name: string, n: number) =>
    `export function ${name}() {\n${
      Array.from({ length: n }, (_, i) => `  const v${i} = ${i};`).join("\n")
    }\n}\n`;
  const dupBlock = (tag: string) =>
    `// dup ${tag}\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n`;

  // Assembled at runtime: spelled out, this file trips the very check these
  // tests exercise, on every later edit to it.
  const up = "../";
  const crossRepo = `${up}${up}core/roles`;

  const run = (file: string) => {
    const r = spawnSync("bash", [join(repoRoot, "hooks", "claude", "coding-police.sh")], {
      input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file, new_string: "x" } }),
      encoding: "utf-8",
    });
    return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status };
  };

  test("a legacy long function is not re-reported when unrelated lines shift it", () => {
    const { dir, file, git } = legacyRepo();
    writeFileSync(file, longFn("legacy", 130));
    git("add", "-A");
    git("commit", "-qm", "legacy");
    // Prepend unrelated lines: the function moves down but is untouched.
    writeFileSync(file, `const x0 = 0;\nconst x1 = 1;\n${longFn("legacy", 130)}`);
    const r = run(file);
    expect(r.out).not.toContain("LONG FUNCTION");
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a NEW long function IS reported even though one already existed", () => {
    // The failure mode of comparing a single max number: the new violation's
    // metric was lower than the legacy one's, so it vanished.
    const { dir, file, git } = legacyRepo();
    writeFileSync(file, longFn("legacy", 130));
    git("add", "-A");
    git("commit", "-qm", "legacy");
    writeFileSync(file, `${longFn("fresh", 112)}${longFn("legacy", 130)}`);
    const r = run(file);
    expect(r.out).toContain("`fresh`");
    expect(r.out).not.toContain("`legacy`");
    expect(r.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an ADDITIONAL duplicate block is reported; the pre-existing ones are not", () => {
    const { dir, file, git } = legacyRepo();
    writeFileSync(file, `${dupBlock("one")}${dupBlock("two")}`);
    git("add", "-A");
    git("commit", "-qm", "legacy dups");
    const r0 = run(file);
    expect(r0.out).not.toContain("DUPLICATE CODE");
    writeFileSync(file, `${dupBlock("one")}${dupBlock("two")}${dupBlock("three")}`);
    const r1 = run(file);
    expect(r1.out).toContain("DUPLICATE CODE");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the export check runs against the baseline too, so an over-cap file stays quiet", () => {
    // The baseline was written to an extensionless temp file, and
    // check_export_count returns early on anything that is not .ts/.tsx/.js/.jsx.
    // So TOO MANY EXPORTS never entered the baseline, could never be subtracted,
    // and every edit to an over-cap file was blocked by a count it did not change.
    const { dir, file, git } = legacyRepo();
    const exports = (n: number) =>
      Array.from({ length: n }, (_, i) => `export const e${i} = ${i};`).join("\n") + "\n";
    writeFileSync(file, exports(20));
    git("add", "-A");
    git("commit", "-qm", "already over the export cap");
    const unchanged = run(file);
    expect(unchanged.out).not.toContain("TOO MANY EXPORTS");
    expect(unchanged.status).toBe(0);
    // One more export IS this edit's doing.
    writeFileSync(file, exports(21));
    const worse = run(file);
    expect(worse.out).toContain("TOO MANY EXPORTS");
    expect(worse.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("shrinking a violation that is still over the limit is silent, not 'different'", () => {
    // Comparing shapes for equality is symmetric: it reported an improvement as
    // a new violation, blocking the exact cleanup the rule asks for. Severity
    // must be compared as a NUMBER, and only upward.
    const { dir, file, git } = legacyRepo();
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
    writeFileSync(file, lines(1200));
    git("add", "-A");
    git("commit", "-qm", "over the length cap");
    writeFileSync(file, lines(1100));
    const shrunk = run(file);
    expect(shrunk.out).not.toContain("FILE TOO LONG");
    expect(shrunk.status).toBe(0);
    // A single line the other way is a regression and must still block.
    writeFileSync(file, lines(1201));
    const grown = run(file);
    expect(grown.out).toContain("FILE TOO LONG");
    expect(grown.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a legacy long function shortened but still over the limit is silent", () => {
    const { dir, file, git } = legacyRepo();
    writeFileSync(file, longFn("legacy", 130));
    git("add", "-A");
    git("commit", "-qm", "legacy");
    writeFileSync(file, longFn("legacy", 115));
    const r = run(file);
    expect(r.out).not.toContain("LONG FUNCTION");
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("functions whose names differ only in digits keep distinct shapes", () => {
    // Blanking every number to compare shapes also rewrote the backticked
    // identifier, so `step1` and `step2` became one shape — and the
    // worse-was-already-there pass then handed a real regression the OTHER
    // function's slot and reported nothing at all. Silence is the fail-open
    // direction, so this is the case that matters most.
    const { dir, file, git } = legacyRepo();
    writeFileSync(file, `${longFn("step2", 120)}${longFn("step1", 250)}`);
    git("add", "-A");
    git("commit", "-qm", "two over-cap functions, digit-suffixed names");
    // One edit: step2 doubles (a real regression) while step1 shrinks.
    writeFileSync(file, `${longFn("step2", 242)}${longFn("step1", 112)}`);
    const r = run(file);
    expect(r.out).toContain("`step2`");
    expect(r.out).not.toContain("`step1`");
    expect(r.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("cross-repo relative paths survive the baseline pass", () => {
    // The subtraction reset the violations array, silently disabling this
    // check on every TRACKED file — exactly the files it targets.
    const { dir, git } = legacyRepo();
    const file = join(dir, "conf.ts");
    writeFileSync(file, `export const p = "${crossRepo}";\n`);
    git("add", "-A");
    git("commit", "-qm", "tracked");
    const r = run(file);
    expect(r.out).toContain("CROSS-REPO RELATIVE PATH");
    expect(r.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
