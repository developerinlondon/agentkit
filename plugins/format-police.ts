import type { PluginInput } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

// Auto-discover dprint binary location
// Priority: 1) mise-managed  2) PATH  3) common locations
function findDprint(): string | null {
  // Check mise-managed install (common pattern)
  const miseGlob = `${process.env.HOME}/.local/share/mise/installs/dprint/*/dprint`
  // Try the PATH first
  const pathResult = spawnSync("which", ["dprint"], {
    timeout: 3000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (pathResult.status === 0 && pathResult.stdout?.trim()) {
    return pathResult.stdout.trim()
  }

  // Check common mise locations
  const { readdirSync } = require("node:fs")
  const { join } = require("node:path")
  const miseDir = join(process.env.HOME || "", ".local/share/mise/installs/dprint")
  try {
    const versions = readdirSync(miseDir).sort().reverse()
    for (const ver of versions) {
      const candidate = join(miseDir, ver, "dprint")
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // mise dir doesn't exist
  }

  return null
}

const FORMATTABLE = /\.(ts|tsx|js|jsx|json|jsonc|md|yaml|yml|toml|css|html)$/

export default async function formatPolice(ctx: PluginInput) {
  const dprintPath = findDprint()
  if (!dprintPath) {
    console.warn("[format-police] dprint binary not found, plugin disabled")
    return {}
  }

  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { title: string; output: string; metadata: unknown },
    ) => {
      const toolName = input.tool?.toLowerCase()
      if (toolName !== "edit" && toolName !== "write") return

      const filePath = output.title
      if (!filePath || !FORMATTABLE.test(filePath)) return
      if (!existsSync(filePath)) return

      try {
        spawnSync(dprintPath, ["fmt", filePath], {
          cwd: ctx.directory,
          timeout: 10000,
          stdio: "ignore",
        })
      } catch {
        // silently ignore format failures
      }
    },
  }
}
