#!/usr/bin/env bash
# issue-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: filing an issue that does not say why it is being filed instead of
# fixed. Presence only — what a disposition should say is the lifecycle skills'
# job, and this hook forms no opinion on the answer.
set -euo pipefail

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)

[[ -z "$COMMAND" ]] && exit 0

# Quoted strings are emptied before the trigger is matched, so a commit message
# or an issue body that quotes the command is not itself a creation. The marker
# search below runs against the original text, where the body still lives.
STRIPPED=$(echo "$COMMAND" |
	sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g" |
	sed -E "s/'[^']*'/''/g")

if ! echo "$STRIPPED" | grep -qiE '\b(gh|glab)[[:space:]]+issue[[:space:]]+create\b'; then
	exit 0
fi

deny() {
	agentkit_deny_json "$1"
	exit 0
}

# A body file is as much the issue text as an inline --body is. Relative paths
# resolve against a `cd <path>` prefix when the command carries one, since that
# is the directory the forge CLI itself would run in.
TARGET_DIR=$(echo "$COMMAND" | sed -nE 's/(^|.*[;&|])[[:space:]]*cd[[:space:]]+([^[:space:];&|]+).*/\2/p' | head -1)
TARGET_DIR="${TARGET_DIR/#\~/$HOME}"

TEXT="$COMMAND"
BODY_FILES=$(echo "$COMMAND" |
	grep -oE -- '(--body-file|--description-file|-F)[[:space:]=]+[^[:space:]"'"'"']+' |
	sed -E 's/^[^[:space:]=]+[[:space:]=]+//' || true)

for body_file in $BODY_FILES; do
	[[ "$body_file" == "-" ]] && continue
	if [[ "$body_file" != /* && -n "$TARGET_DIR" ]]; then
		body_file="$TARGET_DIR/$body_file"
	fi
	[[ -r "$body_file" ]] || continue
	TEXT="$TEXT"$'\n'"$(cat "$body_file" 2>/dev/null || true)"
done

# A closing quote is not an answer: `--body "Disposition:"` would otherwise pass
# on the quote character itself.
DISPOSITION_RE="[Dd]isposition:[[:space:]]*[^[:space:]\"'\`]"

if echo "$TEXT" | grep -qE "$DISPOSITION_RE"; then
	exit 0
fi

deny "BLOCKED: this issue does not say why it is being filed rather than fixed.

Filing is not free. A review finding defaults to being fixed in the change that caused it, and scope carved out of the issue you are working on right now is a deferral needing the operator's sign-off — neither is a new issue by default.

Add a Disposition: line to the issue body naming which case this is, for example:
  Disposition: new work, unrelated to anything in flight
  Disposition: carved out of #<n>, deferral approved by the operator
  Disposition: review finding, not fixable in the change that caused it because <reason>

A body arriving on stdin cannot be read here: pass it inline with --body, or write it to a file and pass --body-file <path>."
