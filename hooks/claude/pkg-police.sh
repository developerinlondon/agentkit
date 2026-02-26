#!/usr/bin/env bash
# pkg-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: npm, npx, yarn, pnpm commands — enforces bun as package manager
# Equivalent to: plugins/pkg-police.ts (OpenCode)
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[[ -z "$COMMAND" ]] && exit 0

deny() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# Check for npm commands (install, run, test, exec, create, init, publish, ci)
if echo "$COMMAND" | grep -qiE '\bnpm\s+(install|i|ci|run|test|init|publish|exec|create)\b'; then
  SUBCMD=$(echo "$COMMAND" | grep -oiE '\bnpm\s+\w+' | head -1)
  deny "BLOCKED: '${SUBCMD}' is not allowed. Use bun instead. Mapping: npm install → bun install, npm run → bun run, npm test → bun test, npm init → bun init, npx → bunx. Override: user explicitly requests npm."
fi

# Check for npx
if echo "$COMMAND" | grep -qiE '\bnpx\s+'; then
  deny "BLOCKED: 'npx' is not allowed. Use 'bunx' instead. Example: npx tsc → bunx tsc. Override: user explicitly requests npx."
fi

# Check for yarn
if echo "$COMMAND" | grep -qiE '\byarn(\s+|$)'; then
  deny "BLOCKED: 'yarn' is not allowed. Use bun instead. Mapping: yarn → bun install, yarn add → bun add, yarn run → bun run. Override: user explicitly requests yarn."
fi

# Check for pnpm
if echo "$COMMAND" | grep -qiE '\bpnpm(\s+|$)'; then
  deny "BLOCKED: 'pnpm' is not allowed. Use bun instead. Mapping: pnpm install → bun install, pnpm add → bun add, pnpm run → bun run. Override: user explicitly requests pnpm."
fi

exit 0
