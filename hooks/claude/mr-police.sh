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

# shellcheck source=lib/hook-input.sh
# Pure bash dirname: external `dirname` is missing when PATH is empty (the
# missing-jq fail-open probe), and a source failure under set -e would silence
# the gate. BASH_SOURCE is absolute when the harness invokes the script by path.
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
# shellcheck source=lib/forge-config.sh
source "${BASH_SOURCE[0]%/*}/lib/forge-config.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)
[[ -z "$COMMAND" ]] && exit 0

# Quoted strings are emptied before the trigger is matched, so an MR body that
# quotes a creation command is not itself a creation.
STRIPPED=$(echo "$COMMAND" |
	sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g" |
	sed -E "s/'[^']*'/''/g")

# The REST path creates exactly the same MR as the CLI does, so a unit that only
# knows the CLI is a gate with a documented way around it.
is_rest_creation() {
	echo "$STRIPPED" | grep -qiE '\b(gh|glab)[[:space:]]+api\b' || return 1
	echo "$STRIPPED" | grep -qiE '(--method|-X)[[:space:]=]+POST\b' || return 1
	echo "$COMMAND" |
		sed -E 's/[[:space:]](--field|--raw-field|-f|--input|--body|--body-file|--description-file)[[:space:]=].*//' |
		grep -qE '/(merge_requests|pulls)([^/[:alnum:]_]|$)'
}

is_cli_creation() {
	echo "$STRIPPED" | grep -qiE 'glab[[:space:]]+mr[[:space:]]+create|gh[[:space:]]+pr[[:space:]]+create|merge_request\.create'
}

# Only act on MR-creation commands; everything else passes through instantly.
is_cli_creation || is_rest_creation || exit 0

deny() {
	agentkit_deny_json "$1"
	exit 0
}

# Every MR carries an assignee from the moment it exists — ownership is never
# ambiguous. Applies to any agent using these hooks (Claude Code, Proxima, …).
if echo "$COMMAND" | grep -qiE 'glab[[:space:]]+mr[[:space:]]+create' \
	&& ! echo "$COMMAND" | grep -qE -- '--assignee|[[:space:]]-a[[:space:]]'; then
	deny "BLOCKED: glab mr create must include an assignee. Add --assignee <username> (or --assignee @me) and retry — unassigned MRs are not allowed."
fi

if is_rest_creation && ! echo "$COMMAND" | grep -qE 'assignee'; then
	deny "BLOCKED: this creates a merge request through the REST API with no assignee.

The API path lands exactly the MR the CLI would, so it carries the same rule — an unassigned MR has no owner from the moment it exists.

Prefer the CLI, which names the flag for you: glab mr create --assignee <username>"
fi

mr_body_text() {
	local text="$COMMAND" file
	for file in $(echo "$COMMAND" |
		grep -oE -- '(--body-file|--description-file|-F)[[:space:]=]+[^[:space:]"'"'"']+' |
		sed -E 's/^[^[:space:]=]+[[:space:]=]+//' || true); do
		[[ "$file" == "-" || ! -r "$file" ]] && continue
		text="$text"$'\n'"$(cat "$file" 2>/dev/null || true)"
	done
	printf '%s' "$text"
}

if agentkit_forge_flag mr-police require-issue-reference; then
	if ! mr_body_text | grep -qE '(#[0-9]+|/issues/[0-9]+|![0-9]+)'; then
		deny "BLOCKED: this merge request names no issue, and this project runs issue-first.

A merged diff with no issue is an orphan: the reason it was made lives in a session nobody else can read.

Reference the issue in the description — Addresses #<n> — or file one first if none covers this work. Turn the requirement off with mr-police.require-issue-reference in .agentkit/config.yaml."
	fi
fi

# GitLab closes an issue when a keyword lands next to its number, which takes the
# completion call away from whoever asked for the work.
if agentkit_forge_flag mr-police forbid-closing-keywords; then
	if mr_body_text | grep -qiE '\b(clos(e|es|ed|ing)|fix(es|ed)?|resolv(e|es|ed)|implement(s|ed)?)\b[[:space:]]*[#!][0-9]+'; then
		deny "BLOCKED: this merge request carries a closing keyword next to an issue reference.

On merge the forge would close that issue, deciding the work is done before the person who asked for it has verified anything.

Write Addresses #<n> or Refs #<n> instead. Turn this off with mr-police.forbid-closing-keywords in .agentkit/config.yaml."
	fi
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
