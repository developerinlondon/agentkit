#!/usr/bin/env bash
# wait-police.sh — Claude Code Stop hook
# Blocks: ending the turn while delegated work is still running and nothing is
# polling it. A completion notification is a courtesy, not a guarantee; a
# session that waits on one alone can idle indefinitely with the work finished.
#
# Liveness comes from the session transcript, which is the only place the
# harness records it: a background task is live between its "running in
# background with ID" tool result and its <task-notification>; a teammate is
# live between its Agent spawn (or a SendMessage to it) and its next
# idle_notification. Nothing on disk carries a status field.
set -uo pipefail

if [[ -n "${AGENTKIT_SKIP_HOOKS:-}" ]]; then
	_skip=",$(printf '%s' "$AGENTKIT_SKIP_HOOKS" | tr -d '[:space:]'),"
	case "$_skip" in
	*",wait-police,"* | *",all,"*) exit 0 ;;
	esac
fi

# A source that fails leaves every helper undefined, which silently disarms the
# hook rather than failing open on purpose. Check the file, then read it.
AGENTKIT_HOOK_LIB="${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
[[ -r "$AGENTKIT_HOOK_LIB" ]] || exit 0
# shellcheck source=lib/hook-input.sh
source "$AGENTKIT_HOOK_LIB"

AUDIT="${HOME:-/tmp}/.agentkit/wait-audit.log"
SESSION="unknown"

audit() {
	mkdir -p "${AUDIT%/*}" 2>/dev/null || return 0
	printf '%s\t%s\tsession=%s\t%s\n' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" \
		"$1" "$SESSION" "${2//$'\n'/ }" >>"$AUDIT" 2>/dev/null || true
}

# Any read that does not answer leaves the session free to stop. A guard that
# traps a turn is worse than one that misses it.
fail_open() {
	audit OPEN "$1"
	exit 0
}

config_disabled() {
	local config="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"
	[[ -f "$config" ]] || return 1
	awk '
		/^[^[:space:]#]/ { in_section = ($0 ~ /^wait-police:/); next }
		in_section {
			line = $0
			sub(/^[[:space:]]+/, "", line)
			if (line ~ /^enabled:[[:space:]]*(false|0|no)[[:space:]]*(#.*)?$/) { found = 1 }
		}
		END { exit(found ? 0 : 1) }
	' "$config"
}

repo_disabled() {
	local flag
	if flag=$(git ${1:+-C "$1"} config --get agentkit.waitpolice.enabled 2>/dev/null); then
		case "$flag" in false | 0 | no) return 0 ;; esac
	fi
	return 1
}

command -v jq >/dev/null 2>&1 || exit 0
agentkit_slurp_input

SESSION=$(agentkit_session_id)
CWD=$(agentkit_jq_raw -r '.cwd // empty')
config_disabled && exit 0
repo_disabled "$CWD" && exit 0

# Claude sets this on the turn a Stop hook already continued. Blocking there is
# how a hook turns one refusal into an infinite loop.
if agentkit_stop_hook_active; then
	audit SKIP "stop_hook_active"
	exit 0
fi

TRANSCRIPT=$(agentkit_transcript_path)
[[ -n "$TRANSCRIPT" && -r "$TRANSCRIPT" ]] || fail_open "no readable transcript"

# A long session's transcript reaches hundreds of megabytes. The grep prefilter
# below is what keeps the scan cheap; the byte cap bounds the pathological case.
# Losing the head of the file can only lose a START, which under-detects — the
# fail-open direction.
SCAN_BYTES="${AGENTKIT_WAIT_POLICE_SCAN_BYTES:-134217728}"

EVENTS=$(
	tail -c "$SCAN_BYTES" "$TRANSCRIPT" 2>/dev/null |
		grep -a -F -e 'run_in_background' -e 'running in background with ID' \
			-e 'task-notification' -e 'idle_notification' \
			-e '"name":"Agent"' -e '"name": "Agent"' \
			-e '"name":"SendMessage"' -e '"name": "SendMessage"' |
		jq -Rr 'fromjson? // empty
			| def txt: if type == "string" then .
				elif type == "array" then (map(select(type == "object") | .text // "") | join("\n"))
				else "" end;
			(.message.content // null)
			| if type == "array" then .[]
				elif type == "string" then {type: "text", text: .}
				else empty end
			| if (.type == "tool_use" and .name == "Bash" and ((.input.run_in_background // false) == true))
				then "CMD\t\(.id // "")\t\((.input.command // "") | @base64)"
			elif (.type == "tool_use" and .name == "Agent")
				then "SPAWN\t\(.input.name // .input.description // "subagent")"
			elif (.type == "tool_use" and .name == "SendMessage")
				then "MSG\t\(.input.to // "")"
			elif (.type == "tool_result")
				then ((.content | txt) as $t
					| if ($t | test("running in background with ID: [A-Za-z0-9_-]+"))
						then "BGSTART\t\($t | capture("ID: (?<i>[A-Za-z0-9_-]+)").i)\t\(.tool_use_id // "")"
						else empty end)
			elif (.type == "text")
				then ((.text // "") as $t
					| if ($t | test("<task-id>[^<]+</task-id>"))
						then "BGEND\t\($t | capture("<task-id>(?<i>[^<]+)</task-id>").i)"
					elif ($t | test("idle_notification") and ($t | test("\"from\":\"[^\"]+\"")))
						then "IDLE\t\($t | capture("\"from\":\"(?<n>[^\"]+)\"").n)"
						else empty end)
			else empty end' 2>/dev/null
) || fail_open "transcript scan failed"

[[ -n "$EVENTS" ]] || exit 0

# Associative arrays are bash 4; the hooks still have to run on the bash macOS
# ships. awk carries the state instead, and emits only what survived.
LIVE=$(printf '%s\n' "$EVENTS" | awk -F'\t' '
	$1 == "CMD" && $2 != "" { cmd[$2] = $3; next }
	$1 == "BGSTART" && $2 != "" { task[$2] = $3; next }
	$1 == "BGEND" && $2 != "" { delete task[$2]; next }
	($1 == "SPAWN" || $1 == "MSG") && $2 != "" { agent[$2] = 1; next }
	$1 == "IDLE" && $2 != "" { delete agent[$2]; next }
	END {
		for (id in task) print "TASK\t" id "\t" cmd[task[id]]
		for (name in agent) print "AGENT\t" name
	}
')

[[ -n "$LIVE" ]] || exit 0

# A poll is bounded when the command itself names the cap it will stop at. A
# bare watch loop is not: it ends when the thing it watches ends, which is the
# case that left a session idle for five hours.
is_bounded_poll() {
	local cmd="$1"
	grep -qE '(^|[^[:alnum:]_.-])wait-for([[:space:]]|$)' <<<"$cmd" && return 0
	grep -qE '(^|[^[:alnum:]_-])timeout[[:space:]]+[0-9]+' <<<"$cmd" && return 0
	grep -qE '(^|[^[:alnum:]_-])(until|while|for)([[:space:]]|$)' <<<"$cmd" || return 1
	grep -qE 'sleep[[:space:]]+[0-9]' <<<"$cmd" || return 1
	# shellcheck disable=SC2016 # grep pattern; $SECONDS is text in the polled command.
	grep -qE 'date[[:space:]]+\+%s|\$SECONDS|SECONDS[[:space:]]*-|deadline|--cap|seq[[:space:]]+[0-9]' <<<"$cmd"
}

ARMED=""
LIVE_TASKS=()
LIVE_AGENTS=()
while IFS=$'\t' read -r kind id encoded; do
	case "$kind" in
	AGENT) LIVE_AGENTS+=("$id") ;;
	TASK)
		cmd=$(printf '%s' "$encoded" | base64 -d 2>/dev/null || true)
		if is_bounded_poll "$cmd"; then
			ARMED="$id"
			break
		fi
		LIVE_TASKS+=("$id — ${cmd:0:120}")
		;;
	esac
done <<<"$LIVE"

if [[ -n "$ARMED" ]]; then
	audit ALLOW "armed poll task=$ARMED"
	exit 0
fi

if [[ ${#LIVE_AGENTS[@]} -eq 0 && ${#LIVE_TASKS[@]} -eq 0 ]]; then
	exit 0
fi

WHAT=""
for name in ${LIVE_AGENTS[@]+"${LIVE_AGENTS[@]}"}; do
	WHAT+="  - subagent ${name} — spawned, no idle notification since"$'\n'
done
for task in ${LIVE_TASKS[@]+"${LIVE_TASKS[@]}"}; do
	WHAT+="  - background task ${task}"$'\n'
done

audit BLOCK "agents=${#LIVE_AGENTS[@]} tasks=${#LIVE_TASKS[@]}"
agentkit_block_json "BLOCKED: delegated work is still running and nothing is polling it.

${WHAT}
A completion notification is a courtesy, not a guarantee. Waiting on one alone is how a session sits idle for hours with the work already finished.

Arm a bounded poll on the artefact and run it with run_in_background, then end the turn:
  wait-for --cap 1800 --every 30 --sha <repo> <ref>
  wait-for --cap 1800 --every 30 --pr-checks <owner/repo> <number>
  wait-for --cap 1800 --every 60 --file-match <path> <regex>
  wait-for --cap 900 --every 30 --url <url> --status 200

The poll must carry its own deadline. A bare 'gh pr checks --watch' or a sleep loop with no cap is not one; wrap it in 'timeout <seconds>' if you must hand-roll it.

If you are deliberately handing back to the user, say in your reply which deadline you are waiting to and what you will do when it passes.

Off switches: AGENTKIT_SKIP_HOOKS=wait-police (session), git config agentkit.waitpolice.enabled false (repo), or 'enabled: false' under 'wait-police:' in agentkit config.yaml (global)."
exit 0
