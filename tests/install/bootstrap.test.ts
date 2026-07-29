import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(import.meta.dir));
const bootstrap = join(repoRoot, "bootstrap.sh");
const timeoutMs = 120_000;

function runBootstrap(home: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [bootstrap, "--no-session-scope", "--no-prompt"], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      AGENTKIT_HOME: join(home, ".agentkit"),
      AGENTKIT_REPO_URL: `file://${repoRoot}`,
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
