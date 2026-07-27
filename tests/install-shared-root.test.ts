import { describe, expect, test } from "bun:test";
import {
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

      // Shared root is advertised in the summary.
      expect(result.stdout).toContain(`Shared root:     ${join(home, ".agentkit")}`);
      expect(readdirSync(canon).length).toBeGreaterThan(5);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
