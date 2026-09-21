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

# The top of the checkout the session stands in, so a session inside one asks
# the same question as one standing above it. Walked for `.git` rather than
# asked of git: this runs before every command, and a process is not free.
WORK_TREE_TOP=""
find_work_tree_top() {
	local dir="$1"
	local depth=0
	WORK_TREE_TOP=""
	while [[ "$depth" -lt 40 ]]; do
		if [[ -e "$dir/.git" ]]; then
			WORK_TREE_TOP="$dir"
			return 0
		fi
		case "$dir" in
			/ | "" | */) return 1 ;;
		esac
		dir="${dir%/*}"
		if [[ -z "$dir" ]]; then
			dir="/"
		fi
		depth=$((depth + 1))
	done
	return 1
}

# .agentkit/tastes covers the sources under it; tastes-vendor is the pre-move
# external root, still bound for one release of grace.
tastes_present() {
	find_work_tree_top "$WORKDIR" || true
	local base
	local dir
	for base in "$WORKDIR" "$WORK_TREE_TOP" "$HOME"; do
		[[ -n "$base" ]] || continue
		for dir in "$base/.agentkit/tastes" "$base/.agentkit/tastes-vendor"; do
			[[ -d "$dir" ]] && return 0
		done
	done
	return 1
}

# A command can act in a repository the session is not standing in — `cd repo &&
# …`, `git -C repo …`, or a wrapper carrying either. Whether that repository has
# tastes is the evaluator's question; what this decides is only whether the
# question is worth asking, because every command an agent runs pays for it.
#
# Read in command position, never anywhere in the text: `rg -C 3`, `make -C src`
# and a commit message mentioning a directory change are none of this hook's
# business, and starting a runtime for them is a cost with nothing at the end.
reaches_elsewhere() {
	local start='(^|[;&|(])[[:space:]]*'
	local launcher='((env|timeout|nohup|sudo|nice|xargs)([[:space:]]+[^;&|()[:space:]]+)*[[:space:]]+)?'
	local changes='(cd|pushd|eval|bash|sh|zsh|dash|ksh)([[:space:]]|$)'
	local points='git([[:space:]][^;&|()]*)?[[:space:]](-C[[:space:]]|--git-dir[=[:space:]]|--work-tree[=[:space:]])'
	[[ "$COMMAND" =~ ${start}${launcher}${changes} ]] && return 0
	[[ "$COMMAND" =~ ${start}${launcher}${points} ]] && return 0
	return 1
}

# Silence is indistinguishable from "no tastes", so an unrunnable hook says so —
# where there was something it would have read.
unchecked() {
	tastes_present || reaches_elsewhere || exit 0
	advise "UNCHECKED: taste-police did not run — $1. Tastes at enforce: block were not applied to this command."
}

# Before paying for a runtime start on every command in every repository.
tastes_present || reaches_elsewhere || exit 0

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
# It sits above every deadline inside the evaluator — the match deadline, git,
# and the whole-command judgment budget — so the inner one always fires first
# and answers. Killed here, the evaluator writes nothing, and every blocking
# taste goes unenforced rather than one.
RUN=("$BUN" "$POLICE")
if command -v timeout >/dev/null 2>&1; then
	RUN=(timeout 12 "$BUN" "$POLICE")
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
