import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(import.meta.dir);
const installScript = join(repoRoot, "install.sh");
const installSource = readFileSync(installScript, "utf-8");
const installSkillsStart = installSource.indexOf("install_skills() {");
const installSkillsEnd = installSource.indexOf("\ninstall_rules() {", installSkillsStart);
const installSkillsFunction = installSource.slice(installSkillsStart, installSkillsEnd);
// A global install intentionally installs and builds dependency-bearing skills.
const globalInstallTimeoutMs = 60_000;

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

describe("shared ~/.agentkit root + client symlinks", () => {
  test("global install writes one skill tree and links clients by name", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkit-shared-"));

    try {
      // Pre-seed a non-agentkit skill next to where links will land — must survive.
      const claudeSkills = join(home, ".claude", "skills");
      mkdirSync(join(claudeSkills, "omc-only-skill"), { recursive: true });
      writeFileSync(join(claudeSkills, "omc-only-skill", "SKILL.md"), "# omc\n");

      const result = spawnSync("bash", [installScript, "--global", "--no-session-scope"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          AGENTKIT_HOME: join(home, ".agentkit"),
        },
        encoding: "utf-8",
        timeout: globalInstallTimeoutMs,
      });
      expect(result.status, result.stderr + "\n" + result.stdout).toBe(0);

      const canon = join(home, ".agentkit", "skills");
      expect(existsSync(join(canon, "code-quality", "SKILL.md"))).toBe(true);

      // Canonical is a real directory, not a symlink.
      expect(lstatSync(join(canon, "code-quality")).isSymbolicLink()).toBe(false);

      // Clients are per-name symlinks into the shared root.
      const claudeLink = join(home, ".claude", "skills", "code-quality");
      const agentsLink = join(home, ".agents", "skills", "code-quality");
      const grokLink = join(home, ".grok", "skills", "code-quality");
      for (const link of [claudeLink, agentsLink, grokLink]) {
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readlinkSync(link)).toBe(join(canon, "code-quality"));
        expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toContain("code-quality");
      }

      // Sibling non-agentkit skill untouched.
      expect(existsSync(join(claudeSkills, "omc-only-skill", "SKILL.md"))).toBe(true);
      expect(lstatSync(join(claudeSkills, "omc-only-skill")).isSymbolicLink()).toBe(false);

      // Rules + instructions + hooks share the same pattern.
      expect(lstatSync(join(home, ".grok", "rules", "coding-standards.md")).isSymbolicLink())
        .toBe(true);
      expect(
        lstatSync(join(home, ".grok", "rules", "anti-glaze.md")).isSymbolicLink(),
      ).toBe(true);
      expect(lstatSync(join(home, ".claude", "hooks", "git-police.sh")).isSymbolicLink()).toBe(
        true,
      );
      expect(
        readlinkSync(join(home, ".claude", "hooks", "git-police.sh")),
      ).toBe(join(home, ".agentkit", "hooks", "git-police.sh"));

      // Dual-payload helper: real file in canon; client lib is a directory
      // symlink (not nested file self-links — that loop made every police
      // fail open after shared-root install).
      const canonLibDir = join(home, ".agentkit", "hooks", "lib");
      const canonLib = join(canonLibDir, "hook-input.sh");
      const clientLibDir = join(home, ".claude", "hooks", "lib");
      const clientLib = join(clientLibDir, "hook-input.sh");
      expect(existsSync(canonLib)).toBe(true);
      expect(lstatSync(canonLib).isSymbolicLink()).toBe(false);
      expect(lstatSync(clientLibDir).isSymbolicLink()).toBe(true);
      expect(readlinkSync(clientLibDir)).toBe(canonLibDir);
      expect(existsSync(clientLib)).toBe(true);
      expect(readFileSync(clientLib, "utf-8")).toContain("agentkit_command");
      const probe = spawnSync(
        "bash",
        [join(home, ".claude", "hooks", "git-police.sh")],
        {
          input: JSON.stringify({
            toolName: "run_terminal_command",
            toolInput: { command: "git push --force origin main" },
          }),
          encoding: "utf-8",
          env: { ...process.env, HOME: home },
          timeout: globalInstallTimeoutMs,
        },
      );
      expect(probe.status, probe.stderr + "\n" + probe.stdout).toBe(0);
      expect(probe.stdout).toContain('"decision": "deny"');

      // Shared root is advertised in the summary.
      expect(result.stdout).toContain(`Shared root:     ${join(home, ".agentkit")}`);
      expect(readdirSync(canon).length).toBeGreaterThan(5);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test("resolves the Bun executable before entering an installed skill directory", () => {
    const root = mkdtempSync(join(tmpdir(), "agentkit-bun-resolution-"));
    const fixtureRepo = join(root, "repo");
    const target = join(root, "installed-skills");
    const bin = join(root, "bin");
    const log = join(root, "bun.log");
    mkdirSync(join(fixtureRepo, "skills", "sample"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(
      join(fixtureRepo, "skills", "sample", "package.json"),
      '{"scripts":{"build":"bun build"}}\n',
    );
    writeFileSync(join(fixtureRepo, "skills", "sample", "SKILL.md"), "# Sample\n");

    const realBun = join(bin, "bun-real");
    writeExecutable(
      realBun,
      `#!/usr/bin/env bash
printf '%s|%s\\n' "$PWD" "$*" >> "$BUN_CALL_LOG"
`,
    );
    writeExecutable(
      join(bin, "bun"),
      `#!/usr/bin/env bash
if [[ "$PWD" != "$BUN_SHIM_CWD" ]]; then
  echo "mise: no Bun version configured for $PWD" >&2
  exit 79
fi
if [[ "$1" == "-e" ]]; then
  printf '%s' "$BUN_REAL_BIN"
  exit 0
fi
exit 80
`,
    );

    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
REPO_DIR="$1"
${installSkillsFunction}
install_skills "$2"`,
          "bash",
          fixtureRepo,
          target,
        ],
        {
          cwd: root,
          encoding: "utf-8",
          env: {
            ...process.env,
            BUN_CALL_LOG: log,
            BUN_REAL_BIN: realBun,
            BUN_SHIM_CWD: fixtureRepo,
            PATH: `${bin}:${process.env.PATH}`,
          },
          timeout: globalInstallTimeoutMs,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(log, "utf-8")).toBe(
        `${join(target, "sample")}|install --silent\n${join(target, "sample")}|run build\n`,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);
});
