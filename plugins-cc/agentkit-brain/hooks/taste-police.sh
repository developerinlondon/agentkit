#!/usr/bin/env bash
# taste-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Refuses a command matching an `enforce: block` taste's rule, with that taste's
# own remedy and named override. Equivalent to: plugins/taste-police.ts.
# Rules are data in the owner's files; this contributes only the interception.
# Matching runs in-process in the evaluator, so no rule value ever reaches a
# shell command, a grep argument, or a path.
set -euo pipefail

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input

[[ "$(agentkit_tool_family)" == "Bash" ]] || exit 0

COMMAND=$(agentkit_command)
[[ -z "$COMMAND" ]] && exit 0

WORKDIR=$(agentkit_workdir)
[[ -n "$WORKDIR" ]] || WORKDIR="$PWD"

deny() {
	agentkit_deny_json "$1"
	exit 0
}

advise() {
	agentkit_advise_json "$1"
	exit 0
}

# .agentkit/tastes covers the sources under it; tastes-vendor is the pre-move
# external root, still bound for one release of grace.
tastes_present() {
	local dir
	for dir in "$WORKDIR/.agentkit/tastes" "$WORKDIR/.agentkit/tastes-vendor" \
		"$HOME/.agentkit/tastes"; do
		[[ -d "$dir" ]] && return 0
	done
	return 1
}

# Silence is indistinguishable from "no tastes", so an unrunnable hook says so —
# where there was something it would have read.
unchecked() {
	tastes_present || exit 0
	advise "UNCHECKED: taste-police did not run — $1. Tastes at enforce: block were not applied to this command."
}

# Before paying for a runtime start on every command in every repository.
tastes_present || exit 0

# The evaluator ships in the taste skill. hooks/ and skills/ are siblings in the
# shared root and in a Claude Code plugin; in the repository the hook sits one
# level deeper.
HOOK_DIR="${BASH_SOURCE[0]%/*}"
POLICE=""
for candidate in \
	"${AGENTKIT_TASTE_SCRIPTS:-/nonexistent}/police.ts" \
	"$HOOK_DIR/../skills/taste/scripts/police.ts" \
	"$HOOK_DIR/../../skills/taste/scripts/police.ts" \
	"$HOME/.agentkit/skills/taste/scripts/police.ts"; do
	if [[ -r "$candidate" ]]; then
		POLICE="$candidate"
		break
	fi
done
[[ -n "$POLICE" ]] || unchecked "the taste skill's evaluator was not found"

BUN="${BUN_BIN:-bun}"
command -v "$BUN" >/dev/null 2>&1 || unchecked "bun is not on PATH"

# shellcheck disable=SC2016 # jq program; dollar-prefixed names are jq variables.
REQUEST=$(_agentkit_jq -n --arg command "$COMMAND" --arg cwd "$WORKDIR" \
	'{command: $command, cwd: $cwd}')

# A bounded pattern against a bounded subject is still someone else's regular
# expression: the ceiling stops a pathological one from holding the session.
RUN=("$BUN" "$POLICE")
if command -v timeout >/dev/null 2>&1; then
	RUN=(timeout 8 "$BUN" "$POLICE")
fi
VERDICT=$(printf '%s' "$REQUEST" | "${RUN[@]+"${RUN[@]}"}" 2>/dev/null || true)

DECISION=$(printf '%s' "$VERDICT" | _agentkit_jq -r '.decision // empty' 2>/dev/null || true)
[[ -n "$DECISION" ]] || unchecked "the taste evaluator produced no verdict"

if [[ "$DECISION" == "deny" ]]; then
	REASON=$(printf '%s' "$VERDICT" | _agentkit_jq -r '.reason // empty')
	deny "$REASON"
fi

NOTICES=$(printf '%s' "$VERDICT" | _agentkit_jq -r '(.notices // []) | join("\n")')
[[ -n "$NOTICES" ]] && advise "$NOTICES"

exit 0
