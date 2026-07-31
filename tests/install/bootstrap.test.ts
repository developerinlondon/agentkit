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

// Fixtures and clones must not see the runner user's global git config —
// forced signing or url rewrites there would fail them on that box only.
const gitIsolation = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(args: string[], opts: Record<string, unknown> = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, ...gitIsolation, ...gitIdentity },
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
  // v0.4.9 then v0.4.10 then an untagged main commit. The two tags exist in that
  // order specifically because a lexical sort ranks v0.4.9 above v0.4.10, so the
  // default-resolution test fails if the ordering is not numeric.
  for (const ref of ["v0.4.9", "v0.4.10", "main"]) {
    writeFileSync(join(dir, "REF_MARKER"), `${ref}\n`);
    git(["-C", dir, "add", "REF_MARKER"]);
    git(["-C", dir, "commit", "-q", "--no-verify", "-m", `at ${ref}`]);
    if (ref !== "main") git(["-C", dir, "tag", "-a", ref, "-m", ref]);
  }
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
      ...gitIsolation,
      AGENTKIT_SKIP_SKILL_DEPS: "1",
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

function installedRef(home: string): string {
  return readFileSync(join(home, ".agentkit-src", "REF_MARKER"), "utf-8").trim();
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

  // The old contract was "a re-run picks up new upstream commits". Under tagged
  // installs that is exactly what must NOT happen: an unreleased commit on main
  // reaching users by default is the thing tagging exists to prevent.
  test("a new commit on main does not reach a default install, but a new tag does", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const origin = join(home, "origin");
      git(["clone", "-q", "--no-local", "--mirror", sharedOrigin(), origin]);

      const first = runBootstrap(home, { AGENTKIT_REPO_URL: `file://${origin}` });
      expect(first.status, first.stderr + "\n" + first.stdout).toBe(0);
      expect(installedRef(home)).toBe("v0.4.10");

      const work = join(home, "work");
      git(["clone", "-q", "--no-local", origin, work]);
      writeFileSync(join(work, "UNRELEASED"), "not for users\n");
      git(["-C", work, "add", "UNRELEASED"]);
      git(["-C", work, "commit", "-q", "--no-verify", "-m", "unreleased"]);
      git(["-C", work, "push", "-q", "origin", "main"]);

      const second = runBootstrap(home, { AGENTKIT_REPO_URL: `file://${origin}` });
      expect(second.status, second.stderr + "\n" + second.stdout).toBe(0);
      expect(existsSync(join(home, ".agentkit-src", "UNRELEASED"))).toBe(false);
      expect(installedRef(home)).toBe("v0.4.10");

      git(["-C", work, "tag", "-a", "v0.4.11", "-m", "v0.4.11"]);
      git(["-C", work, "push", "-q", "origin", "v0.4.11"]);

      const third = runBootstrap(home, { AGENTKIT_REPO_URL: `file://${origin}` });
      expect(third.status, third.stderr + "\n" + third.stdout).toBe(0);
      expect(existsSync(join(home, ".agentkit-src", "UNRELEASED"))).toBe(true);
      expect(third.stdout).toContain("v0.4.11");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  test("the newest tag is chosen numerically, so v0.4.10 beats v0.4.9", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const result = runBootstrap(home);
      expect(result.status, result.stderr + "\n" + result.stdout).toBe(0);
      expect(result.stdout).toContain("Latest release: v0.4.10");
      expect(installedRef(home)).toBe("v0.4.10");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  test("AGENTKIT_REF=main installs the bleeding edge", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const result = runBootstrap(home, { AGENTKIT_REF: "main" });
      expect(result.status, result.stderr + "\n" + result.stdout).toBe(0);
      expect(installedRef(home)).toBe("main");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  test("AGENTKIT_REF pins an older release", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const result = runBootstrap(home, { AGENTKIT_REF: "v0.4.9" });
      expect(result.status, result.stderr + "\n" + result.stdout).toBe(0);
      expect(installedRef(home)).toBe("v0.4.9");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  test("an existing clone is moved to the newly resolved ref", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      expect(runBootstrap(home, { AGENTKIT_REF: "v0.4.9" }).status).toBe(0);
      expect(installedRef(home)).toBe("v0.4.9");

      const second = runBootstrap(home);
      expect(second.status, second.stderr + "\n" + second.stdout).toBe(0);
      expect(second.stdout).toContain("Updating");
      expect(installedRef(home)).toBe("v0.4.10");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeoutMs);

  // Falling back to the default branch here would make "installs are tagged"
  // quietly untrue, so the absence of a tag has to stop the install.
  test("an origin with no release tag fails loudly instead of installing main", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-bootstrap-"));

    try {
      const origin = join(home, "untagged");
      git(["clone", "-q", "--no-local", "--mirror", sharedOrigin(), origin]);
      for (const tag of ["v0.4.9", "v0.4.10"]) git(["-C", origin, "tag", "-d", tag]);

      const result = runBootstrap(home, { AGENTKIT_REPO_URL: `file://${origin}` });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no v<major>.<minor>.<patch> tag");
      expect(existsSync(join(home, ".agentkit-src"))).toBe(false);
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
