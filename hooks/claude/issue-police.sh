#!/usr/bin/env bash
# issue-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: filing an issue that does not say why it is being filed instead of
# fixed. Presence only — what a disposition should say is the lifecycle skills'
# job, and this hook forms no opinion on the answer.
set -euo pipefail

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
# shellcheck source=lib/forge-config.sh
source "${BASH_SOURCE[0]%/*}/lib/forge-config.sh"
# shellcheck source=lib/forge-cache.sh
source "${BASH_SOURCE[0]%/*}/lib/forge-cache.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)

[[ -z "$COMMAND" ]] && exit 0

# Quoted strings are emptied before the trigger is matched, so a commit message
# or an issue body that quotes the command is not itself a creation. The marker
# search below runs against the original text, where the body still lives.
STRIPPED=$(echo "$COMMAND" |
	sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g" |
	sed -E "s/'[^']*'/''/g")

# What matched decides what can be demanded of it: an epic filed over the API
# carries its fields as -f pairs, so flag requires would false-block it, and
# the advisory below is its enforcement instead.
CREATION_KIND=""

is_creation() {
	echo "$STRIPPED" | grep -qiE '\b(gh|glab)[[:space:]]+issue[[:space:]]+create\b' && {
		CREATION_KIND="issue"
		return 0
	}

	echo "$STRIPPED" | grep -qiE '\b(gh|glab)[[:space:]]+api\b' || return 1
	echo "$STRIPPED" | grep -qiE '(--method|-X)[[:space:]=]+POST\b' || return 1

	# STRIPPED has emptied the quoted URL, so the path is read from the original,
	# truncated at the first body flag: an issues URL quoted inside a description
	# is not itself a creation.
	url_part=$(echo "$COMMAND" |
		sed -E 's/[[:space:]](--field|--raw-field|-f|--input|--body|--body-file|--description-file)[[:space:]=].*//')
	# Trailing segment only — /issues/7/notes and /issues_statistics create nothing.
	echo "$url_part" | grep -qE '/issues([^/[:alnum:]_]|$)' && {
		CREATION_KIND="issue"
		return 0
	}
	# Epics are work items with the same board obligations, and were the gap
	# through which a bare epic reached the board unremarked.
	echo "$url_part" | grep -qE '/epics([^/[:alnum:]_]|$)' && {
		CREATION_KIND="epic"
		return 0
	}
	return 1
}

is_creation || exit 0

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

# Bash's own regex reads the value, so this gate needs no python3.
disposition_value() {
	printf '%s\n' "$1" | grep -m1 -ioE '[Dd]isposition:[[:space:]]*.*' | sed -E 's/^[Dd]isposition:[[:space:]]*//'
}

# Strips wrapping quotes/backticks/spaces so a bare closing quote left by the
# shell argument (e.g. `owner-deferred —"`) doesn't itself count as text.
disposition_trim() {
	local s="$1"
	while [[ "$s" == [\ \"\'\`]* ]]; do s="${s:1}"; done
	while [[ "$s" == *[\ \"\'\`] ]]; do s="${s%?}"; done
	printf '%s' "$s"
}

disposition_form_ok() {
	local lower="${1,,}" text
	if [[ "$lower" =~ ^[[:space:]]*owner-(deferred|request)[[:space:]]*(-{1,2}|—)[[:space:]]*(.*)$ ]]; then
		text="$(disposition_trim "${BASH_REMATCH[3]}")"
	elif [[ "$lower" =~ ^[[:space:]]*blocked-by[[:space:]]+(.*)$ ]]; then
		text="$(disposition_trim "${BASH_REMATCH[1]}")"
	else
		return 1
	fi
	[[ -n "$text" ]]
}

BODY_TEXT=""
for body_file in $BODY_FILES; do
	[[ "$body_file" == "-" ]] && continue
	if [[ "$body_file" != /* && -n "$TARGET_DIR" ]]; then
		body_file="$TARGET_DIR/$body_file"
	fi
	[[ -r "$body_file" ]] || continue
	BODY_TEXT="$BODY_TEXT"$'\n'"$(cat "$body_file" 2>/dev/null || true)"
done

# shlex, because a body is a quoted argument containing everything a regex would
# have to survive: newlines, nested quotes, flags quoted inside prose.
forge_flag_value() {
	command -v python3 >/dev/null 2>&1 || return 1
	COMMAND="$COMMAND" python3 -c '
import os, shlex, sys
names = sys.argv[1:]
try:
    parts = shlex.split(os.environ["COMMAND"], comments=False)
except ValueError:
    sys.exit(1)
for i, part in enumerate(parts):
    for name in names:
        if part == name and i + 1 < len(parts):
            print(parts[i + 1])
            sys.exit(0)
        if part.startswith(name + "="):
            print(part[len(name) + 1:])
            sys.exit(0)
sys.exit(1)
' "$@" 2>/dev/null
}

# The REST spelling carries the body as `--field description=…`, not as a flag.
forge_field_value() {
	command -v python3 >/dev/null 2>&1 || return 1
	COMMAND="$COMMAND" python3 -c '
import os, shlex, sys
names = sys.argv[1:]
flags = ("--field", "-f", "--raw-field", "-F")
try:
    parts = shlex.split(os.environ["COMMAND"], comments=False)
except ValueError:
    sys.exit(1)
for i, part in enumerate(parts):
    pair = None
    if part in flags and i + 1 < len(parts):
        pair = parts[i + 1]
    elif part.startswith("--field=") or part.startswith("--raw-field="):
        pair = part.split("=", 1)[1]
    if not pair or "=" not in pair:
        continue
    key, value = pair.split("=", 1)
    if key in names:
        print(value)
        sys.exit(0)
sys.exit(1)
' "$@" 2>/dev/null
}

char_count() { printf '%s' "$1" | wc -c | tr -d ' '; }

# An issue about templates quotes template markers as evidence, so the check
# runs against the prose only: fenced blocks and inline code spans are removed
# first, and a marker still has to own its line to count as unanswered.
strip_quoted() {
	awk '
		/^[[:space:]]*```/ { fenced = !fenced; next }
		fenced { next }
		{ gsub(/`[^`]*`/, ""); print }
	'
}

# A skeleton nobody filled in is worse than no template: it reads as answered.
has_unfilled_skeleton() {
	local prose
	prose="$(printf '%s' "$1" | strip_quoted)"
	echo "$prose" | grep -qE '^[[:space:]]*<!--' && return 0
	echo "$prose" | grep -qE '^[[:space:]]*-[[:space:]]*\[[ xX]?\][[:space:]]*$' && return 0
	echo "$prose" | grep -qE '^[[:space:]]*/(milestone|label|assign)[[:space:]]*%?[[:space:]]*$' && return 0
	return 1
}

# Every check below reads the command through the shlex parser. Without it the
# body and the flags cannot be told apart from prose that mentions them, and a
# gate that cannot read its subject must not refuse it.
completeness_checks() {
	local body min max require assignee
	command -v python3 >/dev/null 2>&1 || {
		agentkit_advise_json "UNCHECKED: issue-police read no further than the disposition — python3 is missing, so the body and metadata of this issue were not examined. Install python3 to enforce issue completeness."
		return 0
	}
	body="$(forge_flag_value --description -d --body -b || true)"
	[[ -z "$body" ]] && body="$(forge_field_value description body || true)"
	[[ -z "$body" ]] && body="$BODY_TEXT"
	body="${body#"${body%%[![:space:]]*}"}"

	# An empty body is wrong everywhere; how short is too short is a house call,
	# so the floor and the ceiling are both opt-in.
	min="$(agentkit_forge_config_or issue-police min-body-chars 0)"
	max="$(agentkit_forge_config_or issue-police max-body-chars 0)"

	if [[ -z "$body" ]]; then
		deny "BLOCKED: this issue has no description.

An issue with a title and nothing else asks the next reader to reconstruct what you already knew. Pass the body with --description (glab) or --body (gh), or write it to a file and pass --description-file / --body-file.

State the problem, what done looks like, and the evidence you have — a few lines beat a heading with nothing under it."
	fi

	if [[ "$min" -gt 0 && "$(char_count "$body")" -lt "$min" ]]; then
		deny "BLOCKED: this issue body is shorter than this project's floor of ${min} characters.

A stub costs the next reader the whole investigation again. Say what is wrong, what done looks like, and cite the evidence — file:line, or the command and what it showed.

Raise or lower the floor with issue-police.min-body-chars in .agentkit/config.yaml."
	fi

	if [[ "$max" -gt 0 && "$(char_count "$body")" -gt "$max" ]]; then
		deny "BLOCKED: this issue body is longer than this project's ceiling of ${max} characters.

Concise is not the same as empty, and neither is complete the same as long. Keep the template's sections, cut the narration: bullets and tables, evidence as citations rather than retellings.

Change the ceiling with issue-police.max-body-chars in .agentkit/config.yaml."
	fi

	if has_unfilled_skeleton "$body"; then
		deny "BLOCKED: this issue body still carries an unfilled template.

A template comment, an empty checkbox, or a bare quick action means the skeleton was pasted and not answered — which reads as a completed issue while carrying no more than the blank form did.

Answer each section, delete the ones that genuinely do not apply (and say why), and remove the guidance comments before filing."
	fi

	require="$(agentkit_forge_config_or issue-police require '')"
	# An epic's fields travel as -f pairs, not flags; requiring flags of it
	# blocks every epic the API can create. The advisory is its enforcement.
	[[ "$CREATION_KIND" == epic ]] || require_fields "$require"

	assignee="$(forge_flag_value --assignee -a || true)"
	[[ -n "$assignee" ]] && refuse_self_assignment "$assignee"
	return 0
}

forge_cli() {
	echo "$STRIPPED" | grep -qiE '\bglab\b' && {
		printf 'glab'
		return 0
	}
	echo "$STRIPPED" | grep -qiE '\bgh\b' && {
		printf 'gh'
		return 0
	}
	return 1
}

forge_project() {
	forge_flag_value --repo -R
}

require_fields() {
	local wanted="$1" field flag value
	[[ -n "$wanted" ]] || return 0
	for field in $(echo "$wanted" | tr ',' ' '); do
		case "$field" in
		labels) flag="--label" ;;
		assignee) flag="--assignee" ;;
		milestone) flag="--milestone" ;;
		weight)
			# A GitLab planning field; gh has no such flag, and a machine-wide
			# require must not block GitHub repositories for a field their forge
			# cannot carry.
			[[ "$(forge_cli || true)" == glab ]] || continue
			flag="--weight"
			;;
		*) continue ;;
		esac
		value="$(forge_flag_value "$flag" "${flag:1:2}" || true)"
		[[ -n "$value" ]] || deny "BLOCKED: this issue has no ${field}, and this project requires one.

An item without ${field} is invisible to the board, the milestone report, or the epic rollup it belongs to — accurate text does not make it findable.

Read what the project actually offers before you choose, then pass ${flag}. Requirements live in issue-police.require in .agentkit/config.yaml."
		if [[ "$field" == labels ]]; then
			refuse_unknown_labels "$value"
		fi
	done
	return 0
}

LABELS_WANTED=""

labels_all_known() {
	local known="$1" label
	for label in $(echo "$LABELS_WANTED" | tr ',' ' '); do
		echo "$known" | grep -qxF "$label" || return 1
	done
	return 0
}

# An invented label is silently dropped by the forge, so the issue lands
# unlabelled while the command that filed it looks correct.
refuse_unknown_labels() {
	local cli project
	LABELS_WANTED="$1"
	cli="$(forge_cli || true)"
	[[ "$cli" == glab ]] || return 0
	command -v glab >/dev/null 2>&1 || return 0
	project="$(forge_project || true)"
	[[ -n "$project" ]] || return 0
	LABEL_PROJECT="$project"
	agentkit_forge_verify "labels/$project" 3600 labels_all_known forge_labels_glab && return 0
	deny "BLOCKED: at least one of these labels does not exist in ${project}: ${LABELS_WANTED}.

A label the project does not define is dropped on creation, so the item lands unlabelled while the command looks right.

List what exists and pick from it: glab label list -R ${project}"
}

# Stated in the passing direction on purpose: an unreachable forge then reads as
# "not self" and the hook fails open, the way every other lookup here does.
identity_is_other() {
	[[ -n "$1" && "$1" != "$ASSIGNEE_WANTED" ]]
}

ASSIGNEE_WANTED=""

# Opt-in, because only a dedicated bot account can tell the two cases apart: an
# agent driving a person's own credentials assigns to that person legitimately,
# while a bot assigning to itself leaves the item unowned.
refuse_self_assignment() {
	local cli me_key
	agentkit_forge_flag issue-police refuse-self-assignment || return 0
	ASSIGNEE_WANTED="$1"
	cli="$(forge_cli || true)"
	[[ -n "$cli" ]] || return 0
	command -v "$cli" >/dev/null 2>&1 || return 0
	me_key="identity/$cli/${GITLAB_HOST:-${GH_HOST:-default}}"
	if [[ "$cli" == glab ]]; then
		agentkit_forge_verify "$me_key" 86400 identity_is_other forge_identity_glab && return 0
	else
		agentkit_forge_verify "$me_key" 86400 identity_is_other forge_identity_gh && return 0
	fi
	deny "BLOCKED: you assigned this item to yourself (${ASSIGNEE_WANTED}), the account this token belongs to.

An item assigned to the authoring agent looks owned and is not: no human is going to see it on their board. Assign the person who asked for the work.

If this account genuinely owns the item, say so and let the operator assign it."
}

forge_identity_glab() { glab api /user 2>/dev/null | jq -r '.username // empty'; }
forge_identity_gh() { gh api user 2>/dev/null | jq -r '.login // empty'; }

LABEL_PROJECT=""
forge_labels_glab() {
	glab label list -R "$LABEL_PROJECT" -F json --per-page 100 2>/dev/null | jq -r '.[].name // empty'
}

# Filed is not finished: the fields no create flag can carry are exactly the
# ones that decide whether the item appears on a board. Advised, not blocked —
# they can only be set after the item exists.
board_hygiene_advice() {
	agentkit_advise_json "FILED, not finished — board metadata is what makes this findable. Before moving on: (1) set the work-item Status off Triage (GitLab: GraphQL statusWidget — boards filter on Status, and a status:: label does not move it); (2) link the parent epic or work item; (3) weight, milestone, assignee, labels; (4) read the item back and verify every field landed — a silent API failure leaves blanks the command line never showed. The complete-work-item-metadata taste is the policy; this reminder exists because it was missed twice."
}

# An epic is a container: the filed-rather-than-fixed question does not apply,
# and its fields travel as -f pairs no flag check can read. It gets the body
# checks and the advisory, not the issue gates.
if [[ "$CREATION_KIND" == epic ]]; then
	completeness_checks
	board_hygiene_advice
	exit 0
fi

if ! echo "$TEXT" | grep -qE "$DISPOSITION_RE"; then
	deny "BLOCKED: this issue does not say why it is being filed rather than fixed.

An issue is not a way to end a lane. Fix the finding in the current change, or file it only for work
the owner explicitly deferred or asked for, or work blocked on something outside your control.

Add a Disposition: line to the issue body in one of these exact forms:
  Disposition: owner-deferred — quote the owner's own words here
  Disposition: owner-request — quote the owner's own words here
  Disposition: blocked-by the external system, person, or permission

A body arriving on stdin cannot be read here: pass it inline with --body, or write it to a file and pass --body-file <path>."
fi

if ! disposition_form_ok "$(disposition_value "$TEXT")"; then
	deny "BLOCKED: an issue is not a way to end a lane. Fix the finding in the current change, or file it
with a Disposition: line in one of these exact forms:
  Disposition: owner-deferred — quote the owner's own words here
  Disposition: owner-request — quote the owner's own words here
  Disposition: blocked-by the external system, person, or permission

The key is case-insensitive; the separator before the free text is a hyphen (- or --) or an em-dash
(—). follow-up, later, future, non-blocking, nice to have, and tech debt describe the deferral this
gate exists to refuse, not a reason for it."
fi

completeness_checks
board_hygiene_advice
exit 0
