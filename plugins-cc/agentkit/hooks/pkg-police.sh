#!/usr/bin/env bash
# pkg-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: npm, npx, yarn, pnpm commands — enforces bun as package manager
# Equivalent to: plugins/pkg-police.ts (OpenCode)
set -euo pipefail

# shellcheck source=lib/hook-input.sh
# Pure bash dirname: external `dirname` is missing when PATH is empty (the
# missing-jq fail-open probe), and a source failure under set -e would silence
# the gate. BASH_SOURCE is absolute when the harness invokes the script by path.
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)

[[ -z "$COMMAND" ]] && exit 0

# User-approved escape hatch for tools that only work with npm/yarn/pnpm.
# Works from the environment or inline (`AGENTKIT_ALLOW_PKG=1 npm ci`) —
# inline assignments never reach the hook process, so honor them from the
# text (same treatment as AGENTKIT_ALLOW_STALE_PUSH in git-police).
PKG_OK="${AGENTKIT_ALLOW_PKG:-0}"
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])AGENTKIT_ALLOW_PKG=1([[:space:];&|]|$)'; then
  PKG_OK=1
fi
[[ "$PKG_OK" == "1" ]] && exit 0

deny() {
  local reason="$1"
  agentkit_deny_json "$reason"
  exit 0
}

# Check for npm commands (install, run, test, exec, create, init, publish, ci)
if echo "$COMMAND" | grep -qiE '\bnpm\s+(install|i|ci|run|test|init|publish|exec|create)\b'; then
  SUBCMD=$(echo "$COMMAND" | grep -oiE '\bnpm\s+\w+' | head -1)
  deny "BLOCKED: '${SUBCMD}' is not allowed. Use bun instead. Mapping: npm install → bun install, npm run → bun run, npm test → bun test, npm init → bun init, npx → bunx. Override (only when the user approves npm): prefix with AGENTKIT_ALLOW_PKG=1."
fi

# Check for npx
if echo "$COMMAND" | grep -qiE '\bnpx\s+'; then
  deny "BLOCKED: 'npx' is not allowed. Use 'bunx' instead. Example: npx tsc → bunx tsc. Override (only when the user approves npx): prefix with AGENTKIT_ALLOW_PKG=1."
fi

# Check for yarn
if echo "$COMMAND" | grep -qiE '\byarn(\s+|$)'; then
  deny "BLOCKED: 'yarn' is not allowed. Use bun instead. Mapping: yarn → bun install, yarn add → bun add, yarn run → bun run. Override (only when the user approves yarn): prefix with AGENTKIT_ALLOW_PKG=1."
fi

# Check for pnpm
if echo "$COMMAND" | grep -qiE '\bpnpm(\s+|$)'; then
  deny "BLOCKED: 'pnpm' is not allowed. Use bun instead. Mapping: pnpm install → bun install, pnpm add → bun add, pnpm run → bun run. Override (only when the user approves pnpm): prefix with AGENTKIT_ALLOW_PKG=1."
fi

exit 0
