#!/usr/bin/env bash
# mr-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks opening a NEW merge request while you already have open MR(s) you
# authored on the same repo. Stops unmerged MRs from accumulating into a tangle
# of interdependent branches — merge or close the existing one(s) first.
#
# Threshold is configurable: AGENTKIT_MR_POLICE_MAX (default 1) = how many open
# MRs you may already have before opening another is blocked.
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

# Only act on MR-creation commands; everything else passes through instantly.
if ! echo "$COMMAND" | grep -qiE 'glab[[:space:]]+mr[[:space:]]+create|merge_request\.create'; then
	exit 0
fi

deny_early() {
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
	deny_early "BLOCKED: glab mr create must include an assignee. Add --assignee <username> (or --assignee @me) and retry — unassigned MRs are not allowed."
fi

# Need glab to check; if it's unavailable, don't block (fail open).
command -v glab >/dev/null 2>&1 || exit 0

# Target the GitLab instance this repo lives on (glab otherwise defaults to
# gitlab.com, or to a stale GITLAB_HOST in the environment).
HOST=$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@|https?://)([^:/]+).*#\2#')
[[ -n "$HOST" ]] && export GITLAB_HOST="$HOST"

MAX_OPEN="${AGENTKIT_MR_POLICE_MAX:-1}"

# Who am I, and what open MRs have I authored on this repo?
ME=$(glab api /user 2>/dev/null | jq -r '.username // empty')
[[ -z "$ME" ]] && exit 0

MINE=$(glab mr list --author "$ME" 2>/dev/null | grep -oE '!\b[0-9]+' | sort -u)
COUNT=$(printf '%s\n' "$MINE" | grep -c . || true)

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

if [[ "$COUNT" -ge "$MAX_OPEN" ]]; then
	LIST=$(printf '%s ' $MINE)
	deny "BLOCKED: you already have ${COUNT} open MR(s) you authored on this repo (${LIST}). Do not stack another unmerged MR on top — merge or close the existing one(s) first, then open the next. If these are genuinely independent and must coexist, raise the limit for this command with AGENTKIT_MR_POLICE_MAX=<n>."
fi

exit 0
