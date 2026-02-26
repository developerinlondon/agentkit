import type { PluginInput } from '@opencode-ai/plugin';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Blocked package manager commands and their bun equivalents.
 *
 * Pattern: regex matching the forbidden command invocation.
 * Replacement: human-readable bun equivalent for the error message.
 */
const BLOCKED_COMMANDS: Array<{ pattern: RegExp; tool: string; replacement: string }> = [
  { pattern: /\bnpm\s+install\b/i, tool: 'npm install', replacement: 'bun install' },
  { pattern: /\bnpm\s+i\b/i, tool: 'npm i', replacement: 'bun install' },
  { pattern: /\bnpm\s+ci\b/i, tool: 'npm ci', replacement: 'bun install --frozen-lockfile' },
  { pattern: /\bnpm\s+run\b/i, tool: 'npm run', replacement: 'bun run' },
  { pattern: /\bnpm\s+test\b/i, tool: 'npm test', replacement: 'bun test' },
  { pattern: /\bnpm\s+init\b/i, tool: 'npm init', replacement: 'bun init' },
  { pattern: /\bnpm\s+publish\b/i, tool: 'npm publish', replacement: 'bun publish' },
  { pattern: /\bnpm\s+exec\b/i, tool: 'npm exec', replacement: 'bunx' },
  { pattern: /\bnpm\s+create\b/i, tool: 'npm create', replacement: 'bun create' },
  { pattern: /\bnpx\s+/i, tool: 'npx', replacement: 'bunx' },
  { pattern: /\byarn\s+/i, tool: 'yarn', replacement: 'bun' },
  { pattern: /\byarn$/im, tool: 'yarn', replacement: 'bun install' },
  { pattern: /\bpnpm\s+/i, tool: 'pnpm', replacement: 'bun' },
  { pattern: /\bpnpm$/im, tool: 'pnpm', replacement: 'bun install' },
];

function getAgentkitConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'agentkit', 'config.yaml');
}

function isDisabled(): boolean {
  try {
    const content = readFileSync(getAgentkitConfigPath(), 'utf-8');
    // Simple YAML check: pkg-police:\n  enabled: false
    if (/pkg-police:\s*\n\s+enabled:\s*false/i.test(content)) return true;
    return false;
  } catch {
    return false;
  }
}

function detectBlockedPkgManager(command: string): string | null {
  for (const { pattern, tool, replacement } of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return (
        `BLOCKED: '${tool}' is not allowed. Use bun instead.\n` +
        `\n` +
        `Replace with: ${replacement}\n` +
        `\n` +
        `Quick reference:\n` +
        `  npm install / yarn / pnpm install  →  bun install\n` +
        `  npm install <pkg>                  →  bun add <pkg>\n` +
        `  npm run <script>                   →  bun run <script>\n` +
        `  npx <cmd>                          →  bunx <cmd>\n` +
        `  npm test                           →  bun test\n` +
        `\n` +
        `Override: set pkg-police.enabled: false in agentkit config,\n` +
        `or user explicitly requests a different package manager.`
      );
    }
  }
  return null;
}

export default async function pkgPolice(_ctx: PluginInput) {
  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      const toolName = input.tool?.toLowerCase();
      if (toolName !== 'bash') return;
      if (isDisabled()) return;

      const command = output.args.command as string | undefined;
      if (!command) return;

      const error = detectBlockedPkgManager(command);
      if (error) {
        throw new Error(error);
      }
    },
  };
}
