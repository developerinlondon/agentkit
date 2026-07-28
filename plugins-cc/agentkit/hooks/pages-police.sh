#!/usr/bin/env bash
# pages-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: direct writes to the AgentKit Pages API (bypasses the publish-time
# figure lint and canonical git history) and unapproved --allow-bare-svg.
set -euo pipefail

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)

[[ -z "$COMMAND" ]] && exit 0

deny() {
  agentkit_deny_json "$1"
  exit 0
}

# Writes must go through publish.ts: it lints figures, caps size, and commits
# canonical history. A raw PUT with the bearer token skips all three. Reads
# (GET/HEAD) stay allowed.
if echo "$COMMAND" | grep -qE '/api/pages'; then
  API_WRITE=0
  if echo "$COMMAND" | grep -qiE '\b(curl|wget)\b' \
    && echo "$COMMAND" | grep -qiE '((-X|--request|--method)[[:space:]=]*(PUT|POST|DELETE)|--upload-file|[[:space:]]-T[[:space:]]|--data|--json|--form|[[:space:]]-d[[:space:]])'; then
    API_WRITE=1
  fi
  # httpie/xh take the method as a bare word: `http PUT …/api/pages/x`.
  if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])(http|xh)[[:space:]]' \
    && echo "$COMMAND" | grep -qE '\b(PUT|POST|DELETE)\b'; then
    API_WRITE=1
  fi
  if [[ "$API_WRITE" == "1" ]]; then
    deny "BLOCKED: direct write to the Pages API. Publish through skills/publish-page/publish.ts — it enforces the figure lint (illegible-diagram guard), the 5 MB cap, and the canonical git commit; a raw API write bypasses all three. Deletes: publish.ts --delete --name <name>."
  fi
fi

# --allow-bare-svg skips the figure lint; that is a user decision, not an
# agent convenience. Same override convention as AGENTKIT_ALLOW_PKG.
if echo "$COMMAND" | grep -qE -- '--allow-bare-svg'; then
  BARE_OK="${AGENTKIT_ALLOW_BARE_SVG:-0}"
  if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])AGENTKIT_ALLOW_BARE_SVG=1([[:space:];&|]|$)'; then
    BARE_OK=1
  fi
  if [[ "$BARE_OK" != "1" ]]; then
    deny "BLOCKED: --allow-bare-svg skips the figure-legibility lint. Fix the page instead (wrap the diagram in a .figure island or style its container with var(--diagram-bg)). Only when the USER has approved shipping a bare diagram, prefix with AGENTKIT_ALLOW_BARE_SVG=1."
  fi
fi

exit 0
