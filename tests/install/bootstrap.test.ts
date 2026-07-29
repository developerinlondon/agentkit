import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(import.meta.dir));
const bootstrap = join(repoRoot, "bootstrap.sh");
const timeoutMs = 120_000;
const gitIdentity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(args: string[], opts: Record<string, unknown> = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, ...gitIdentity },
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result;
}

// CI checks out a partial (promisor) clone that cannot serve full clones of
// itself, so the tests build one self-contained origin from the tracked files
// and bootstrap from that.
let originDir: string | null = null;
function sharedOrigin(): string {
  if (originDir) return originDir;
  const dir = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-origin-"));
  const files = git(["-C", repoRoot, "ls-files", "-z"]).stdout.split("\0").filter(Boolean);
  for (const file of files) {
    const dst = join(dir, file);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(repoRoot, file), dst);
  }
  git(["init", "-q", "-b", "main", dir]);
  git(["-C", dir, "add", "-A"]);
  git(["-C", dir, "commit", "-q", "--no-verify", "-m", "synthetic origin"]);
  originDir = dir;
  return dir;
}
afterAll(() => {
  if (originDir) rmSync(originDir, { recursive: true, force: true });
});

function runBootstrap(home: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []) {
  return spawnSync("bash", [bootstrap, "--no-session-scope", "--no-prompt", ...extraArgs], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      AGENTKIT_HOME: join(home, ".agentkit"),
      AGENTKIT_REPO_URL: `file://${sharedOrigin()}`,
      AGENTKIT_SRC: join(home, ".agentkit-src"),
      ...extraEnv,
    },
    encoding: "utf-8",
    timeout: timeoutMs,
  });
}

describe("curl-pipe bootstrap", () => {
  test("clones the kit and hands off to a global install; re-run updates", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const first = runBootstrap(home);
      expect(first.status, first.stderr + "\n" + first.stdout).toBe(0);
      expect(first.stdout).toContain("[bootstrap] Cloning");
      expect(existsSync(join(home, ".agentkit-src", ".git"))).toBe(true);
      expect(existsSync(join(home, ".agentkit", "skills"))).toBe(true);

      const second = runBootstrap(home);
      expect(second.status, second.stderr + "\n" + second.stdout).toBe(0);
      expect(second.stdout).toContain("[bootstrap] Updating");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  test("refuses to update a clone with local modifications", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const first = runBootstrap(home);
      expect(first.status, first.stderr + "\n" + first.stdout).toBe(0);

      writeFileSync(join(home, ".agentkit-src", "README.md"), "local edit\n");
      const second = runBootstrap(home);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain("local changes");
      expect(readFileSync(join(home, ".agentkit-src", "README.md"), "utf-8")).toBe("local edit\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  test("re-run pulls new upstream commits into the source dir", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const origin = join(home, "origin");
      git(["clone", "-q", "--no-local", sharedOrigin(), origin]);

      const first = runBootstrap(home, { AGENTKIT_REPO_URL: `file://${origin}` });
      expect(first.status, first.stderr + "\n" + first.stdout).toBe(0);

      writeFileSync(join(origin, "UPSTREAM_MARKER"), "new\n");
      git(["-C", origin, "add", "UPSTREAM_MARKER"]);
      git(["-C", origin, "commit", "-q", "--no-verify", "-m", "upstream marker"]);

      const second = runBootstrap(home, { AGENTKIT_REPO_URL: `file://${origin}` });
      expect(second.status, second.stderr + "\n" + second.stdout).toBe(0);
      expect(existsSync(join(home, ".agentkit-src", "UPSTREAM_MARKER"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  test("passes arguments through to the installer", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const result = runBootstrap(home, {}, ["--with", "product"]);
      expect(result.status, result.stderr + "\n" + result.stdout).toBe(0);
      expect(existsSync(join(home, ".agentkit", "skills", "product-intelligence"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  test("refuses a source dir that exists but is not a clone", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      mkdirSync(join(home, ".agentkit-src"), { recursive: true });
      writeFileSync(join(home, ".agentkit-src", "somefile"), "not a clone\n");

      const result = runBootstrap(home);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a git clone");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);
});
