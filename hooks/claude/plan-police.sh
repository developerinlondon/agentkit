#!/usr/bin/env bash
# plan-police.sh — Claude Code PreToolUse hook (matcher: Edit|Write)
# Blocks: marking a plan done while its own gaps section still lists a gap that
# is neither closed nor carried by an issue. The judgement is plan-gate's; this
# hook only reconstructs the post-edit content and hands it over. PreToolUse
# because the point is to refuse the edit — a PostToolUse hook must exit 2 to be
# heard at all, and by then the claim is already written.
set -euo pipefail

if [[ -n "${AGENTKIT_SKIP_HOOKS:-}" ]]; then
	_skip=",$(printf '%s' "$AGENTKIT_SKIP_HOOKS" | tr -d '[:space:]'),"
	case "$_skip" in
	*",plan-police,"* | *",all,"*) exit 0 ;;
	esac
fi

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input

if ! agentkit_is_file_write_tool; then
	exit 0
fi

FILE_PATH=$(agentkit_file_path)
[[ -n "$FILE_PATH" ]] || exit 0
case "$FILE_PATH" in
*.md | *.markdown) ;;
*) exit 0 ;;
esac

HOOK_DIR="${BASH_SOURCE[0]%/*}"
PLAN_GATE=""
for candidate in "$HOOK_DIR/../tools/plan-gate" "$HOOK_DIR/../../tools/plan-gate"; do
	if [[ -x "$candidate" ]]; then
		PLAN_GATE="$candidate"
		break
	fi
done

FILE_DIR="${FILE_PATH%/*}"
[[ "$FILE_DIR" == "$FILE_PATH" ]] && FILE_DIR="$PWD"
REPO=$(git -C "$FILE_DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$FILE_DIR")

if [[ -z "$PLAN_GATE" ]]; then
	# A missing checker must not read as a clean plan. Say so once, on the files
	# it would have judged, rather than passing silently on every edit.
	case "$FILE_PATH" in
	*/plans/* | */plan/*)
		agentkit_advise_json "plan-police: the packaged plan-gate checker is missing, so this plan's gaps were NOT checked. Reinstall agentkit, or run plan-gate manually before calling the plan done."
		;;
	esac
	exit 0
fi

if ! "$PLAN_GATE" --repo "$REPO" --matches "$FILE_PATH" >/dev/null 2>&1; then
	exit 0
fi

# split/1 takes its separator literally, so an old_string full of regex
# metacharacters stays data. It is also the only codepoint-safe option: jq's
# string `index` reports a BYTE offset while `.[a:b]` slices codepoints, so one
# em dash earlier in the file shifts every replacement two characters.
compose_content() {
	local existing=""
	if [[ -f "$FILE_PATH" ]]; then
		existing=$(cat "$FILE_PATH")
	fi
	printf '%s' "$existing" | jq -Rs --argjson payload "$(agentkit_jq_raw -c '.tool_input // .toolInput // {}')" '
		. as $original
		| ($payload.content // $payload.new_str // null) as $whole
		| if $whole != null and ($payload.old_string // $payload.oldString // null) == null then $whole
		  else
		    (if ($payload.edits | type) == "array" then $payload.edits else [$payload] end)
		    | reduce .[] as $edit ($original;
		        . as $text
		        | ($edit.old_string // $edit.oldString // "") as $old
		        | ($edit.new_string // $edit.newString // "") as $new
		        | if $old == "" then $text
		          elif ($edit.replace_all // $edit.replaceAll // false) then ($text | split($old) | join($new))
		          else ($text | split($old)) as $parts
		            | if ($parts | length) <= 1 then $text
		              else $parts[0] + $new + ($parts[1:] | join($old))
		              end
		          end)
		  end
	' -r
}

CONTENT=$(compose_content 2>/dev/null || true)
[[ -n "$CONTENT" ]] || exit 0

if GAPS=$(printf '%s' "$CONTENT" | "$PLAN_GATE" --require-done --stdin "$FILE_PATH" 2>/dev/null); then
	exit 0
fi

agentkit_deny_json "BLOCKED: this edit marks ${FILE_PATH##*/} done while its own gaps section still lists work that is neither closed nor tracked by an issue.

${GAPS}

Close each gap one of two ways: tick it (\`- [x] …\`) or strike it through once it no longer applies, or file an issue and name it on the line (\`#123\`, \`!123\`, \`GH-123\`, or the issue URL). A gap that survives the plan with no issue behind it is how work disappears.

A Jira-style PROJ-123 is NOT recognised by default — nothing tells it apart from a hex digest or a UTF-8 label, and a wrong \"tracked\" loses the gap silently. Set wip.issue-refs in .agentkit/config.yaml to accept it.

To record a deliberate exception, set AGENTKIT_SKIP_HOOKS=plan-police for the session."
exit 0
