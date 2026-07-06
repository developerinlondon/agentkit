#!/usr/bin/env bash
# mr-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks opening a NEW merge request while you already have open MR(s) you
# authored on the same repo. Stops unmerged MRs from accumulating into a tangle
# of interdependent branches — merge or close the existing one(s) first.
#
# The repo is resolved from the command itself, not the hook's cwd (which may
# be a different repo entirely): an explicit --repo/-R flag wins, then a
# `cd <path>` prefix, then the cwd.
#
# Threshold is configurable: AGENTKIT_MR_POLICE_MAX (default 1) = how many open
# MRs you may already have before opening another is blocked. Honored from the
# hook's environment or inline in the command (`AGENTKIT_MR_POLICE_MAX=2 glab
# mr create …`) — inline assignments never reach the hook process.
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

# Only act on MR-creation commands; everything else passes through instantly.
if ! echo "$COMMAND" | grep -qiE 'glab[[:space:]]+mr[[:space:]]+create|merge_request\.create'; then
	exit 0
fi

deny() {
	jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
	exit 0
}

# Every MR carries an assignee from the moment it exists — ownership is never
# ambiguous. Applies to any agent using these hooks (Claude Code, Proxima, …).
if echo "$COMMAND" | grep -qiE 'glab[[:space:]]+mr[[:space:]]+create' \
	&& ! echo "$COMMAND" | grep -qE -- '--assignee|[[:space:]]-a[[:space:]]'; then
	deny "BLOCKED: glab mr create must include an assignee. Add --assignee <username> (or --assignee @me) and retry — unassigned MRs are not allowed."
fi

# Need glab to check; if it's unavailable, don't block (fail open).
command -v glab >/dev/null 2>&1 || exit 0

# The repo the command targets, in priority order:
# 1. explicit --repo/-R on the glab command (OWNER/REPO, HOST/OWNER/REPO, or URL)
REPO_ARG=$(echo "$COMMAND" | sed -nE 's/.*(--repo[= ]|-R[[:space:]]+)([^[:space:]"'"'"']+).*/\2/p' | head -1)

# 2. a `cd <path>` at the start or after a separator (; && |) — glab resolves
#    the repo from that directory, so the check must too.
TARGET_DIR=$(echo "$COMMAND" | sed -nE 's/(^|.*[;&|])[[:space:]]*cd[[:space:]]+([^[:space:];&|]+).*/\2/p' | head -1)
TARGET_DIR="${TARGET_DIR/#\~/$HOME}"

# 3. the hook's cwd (previous behavior) via plain git below.
ORIGIN_URL=$(git ${TARGET_DIR:+-C "$TARGET_DIR"} remote get-url origin 2>/dev/null || echo "")
[[ -z "$REPO_ARG" && -n "$ORIGIN_URL" ]] && REPO_ARG="$ORIGIN_URL"

# Target the GitLab instance this repo lives on (glab otherwise defaults to
# gitlab.com, or to a stale GITLAB_HOST in the environment).
HOST=$(echo "$ORIGIN_URL" | sed -E 's#^(git@|https?://)([^:/]+).*#\2#')
[[ -n "$HOST" ]] && export GITLAB_HOST="$HOST"

# Threshold: inline assignment in the command wins over the hook's environment.
MAX_OPEN="${AGENTKIT_MR_POLICE_MAX:-1}"
INLINE_MAX=$(echo "$COMMAND" | grep -oE '(^|[[:space:];&|])AGENTKIT_MR_POLICE_MAX=[0-9]+' | head -1 | sed -E 's/.*=([0-9]+)/\1/' || true)
[[ -n "$INLINE_MAX" ]] && MAX_OPEN="$INLINE_MAX"

# Who am I, and what open MRs have I authored on the targeted repo?
ME=$(glab api /user 2>/dev/null | jq -r '.username // empty')
[[ -z "$ME" ]] && exit 0

# `|| true`: zero matches must mean "no open MRs", not a pipefail crash that
# silently fails the hook open.
MINE=$(glab mr list --author "$ME" ${REPO_ARG:+--repo "$REPO_ARG"} 2>/dev/null | grep -oE '!\b[0-9]+' | sort -u || true)
COUNT=$(printf '%s\n' "$MINE" | grep -c . || true)

if [[ "$COUNT" -ge "$MAX_OPEN" ]]; then
	LIST=$(printf '%s ' $MINE)
	deny "BLOCKED: you already have ${COUNT} open MR(s) you authored on this repo (${LIST}). Do not stack another unmerged MR on top — merge or close the existing one(s) first, then open the next. If these are genuinely independent and must coexist, raise the limit by prefixing the command with AGENTKIT_MR_POLICE_MAX=<n>."
fi

exit 0
