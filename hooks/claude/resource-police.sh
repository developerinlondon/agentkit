#!/bin/bash
set -euo pipefail

readonly AWK_BIN=/usr/bin/awk
readonly CAT_BIN=/usr/bin/cat
readonly JQ_BIN=/usr/bin/jq

INPUT=$("$CAT_BIN")
COMMAND=$(printf '%s' "$INPUT" | "$JQ_BIN" -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

# User-approved escape hatch for sanctioned delegated workloads (e.g. an
# approved ansible apply). Heavy commands stay bounded regardless. Works from
# the environment or inline (`AGENTKIT_ALLOW_DELEGATED=1 ansible-playbook …`);
# inline assignments never reach the hook process, so honor them from the text
# (same treatment as AGENTKIT_ALLOW_STALE_PUSH in git-police).
DELEGATED_OK="${AGENTKIT_ALLOW_DELEGATED:-0}"
if printf '%s' "$COMMAND" \
	| grep -qE '(^|[[:space:];&|])AGENTKIT_ALLOW_DELEGATED=1([[:space:];&|]|$)'; then
	DELEGATED_OK=1
fi

deny() {
	local segment="$1"
	local kind="${2:-heavy}"
	local reason
	local runner_hint=agentkit-run
	if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -x "$CLAUDE_PLUGIN_ROOT/tools/agentkit-run" ]]; then
		runner_hint="$CLAUDE_PLUGIN_ROOT/tools/agentkit-run"
	elif [[ -x "$PWD/.claude/tools/agentkit-run" ]]; then
		runner_hint="$PWD/.claude/tools/agentkit-run"
	fi
	if [[ "$kind" == delegated ]]; then
		reason="BLOCKED: delegated workload cannot be contained by agentkit-run: $segment. Use a separately approved dedicated runner or verified engine-native limits. User-approved delegated workloads: prefix with AGENTKIT_ALLOW_DELEGATED=1."
	else
		reason="BLOCKED: resource-intensive command is not contained: $segment. Run it through $runner_hint, for example: $runner_hint --profile compile -- bun run typecheck. Use profile browser for Playwright and browser builds."
	fi
	"$JQ_BIN" -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
	exit 0
}

split_segments() {
	"$AWK_BIN" '
    function emit() {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", segment)
      if (length(segment)) print segment
      segment = ""
    }
    {
      for (position = 1; position <= length($0); position++) {
        character = substr($0, position, 1)
        next_character = substr($0, position + 1, 1)
        if (escaped) {
          segment = segment character
          escaped = 0
          continue
        }
        if (character == "\\" && !single_quote) {
          segment = segment character
          escaped = 1
          continue
        }
        if (character == sprintf("%c", 39) && !double_quote) {
          single_quote = !single_quote
          segment = segment character
          continue
        }
        if (character == "\"" && !single_quote) {
          double_quote = !double_quote
          segment = segment character
          continue
        }
        pair = character next_character
        if (!single_quote && !double_quote &&
            (character == ";" || character == "|" || character == "&" ||
             character == "(" || character == ")" || character == "{" ||
             character == "}" || pair == "&&")) {
          emit()
          if (pair == "&&" || pair == "||") position++
          continue
        }
        segment = segment character
      }
      if (!single_quote && !double_quote) emit()
      else segment = segment "\n"
    }
    END { emit() }
  '
}

parse_launch() {
	local segment="$1"
	local token
	local index=0
	read -r -a TOKENS <<<"$segment"
	while [[ -n "${TOKENS[$index]:-}" ]]; do
		while [[ "${TOKENS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
			index=$((index + 1))
		done
		token="${TOKENS[$index]:-}"
		token="${token//\"/}"
		token="${token//\'/}"
		case "${token##*/}" in
		sudo | doas | pkexec | run0)
			EXECUTABLE="${token##*/}"
			ARGS=("${TOKENS[@]:$((index + 1))}")
			return 0
			;;
		env)
			index=$((index + 1))
			while [[ "${TOKENS[$index]:-}" == -* \
				|| "${TOKENS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
				index=$((index + 1))
			done
			;;
		command | nohup | time)
			index=$((index + 1))
			while [[ "${TOKENS[$index]:-}" == -* ]]; do index=$((index + 1)); done
			;;
		*) break ;;
		esac
	done
	token="${TOKENS[$index]:-}"
	token="${token//\"/}"
	token="${token//\'/}"
	EXECUTABLE="${token##*/}"
	EXECUTABLE_TOKEN="$token"
	ARGS=("${TOKENS[@]:$((index + 1))}")
}

is_heavy() {
	local executable="${EXECUTABLE,,}"
	local first="${ARGS[0]:-}"
	local second="${ARGS[1]:-}"
	case "$executable" in
	bun)
		[[ "$first" =~ ^(add|install|update|test)$ ]] && return 0
		[[ "$first" == run && "$second" =~ ^(build|check|type-?check|lint|test)(:[[:alnum:]_-]+)?$ ]]
		;;
	bunx | npx)
		[[ "$first" == tsc && "$second" != --version ]] \
			|| [[ "$first" == playwright && "$second" == test ]]
		;;
	npm | pnpm)
		[[ "$first" =~ ^(add|install|i|ci|update|upgrade|test)$ ]] && return 0
		[[ "$first" == run && "$second" =~ ^(build|check|type-?check|lint|test)(:[[:alnum:]_-]+)?$ ]]
		;;
	yarn)
		[[ -z "$first" ]] && return 0
		[[ "$first" =~ ^(add|install|up|upgrade|test)$ ]] && return 0
		[[ "$first" == run && "$second" =~ ^(build|check|type-?check|lint|test)(:[[:alnum:]_-]+)?$ ]] && return 0
		[[ "$first" =~ ^(build|check|type-?check|lint)(:[[:alnum:]_-]+)?$ ]]
		;;
	tsc) [[ "$first" != --version ]] ;;
	playwright) [[ "$first" == test ]] ;;
	cargo) [[ "$first" =~ ^(build|check|test|clippy)$ ]] ;;
	go) [[ "$first" =~ ^(build|test)$ ]] ;;
	pip | pip3) [[ "$first" == install ]] ;;
	uv)
		[[ "$first" =~ ^(add|sync)$ ]] && return 0
		[[ "$first" == pip && "$second" == install ]] && return 0
		[[ "$first" == run && "$second" == pytest ]]
		;;
	pytest) return 0 ;;
	python | python3) [[ "$first" == -m && "$second" == pytest ]] ;;
	*) return 1 ;;
	esac
}

shell_command_payload() {
	PAYLOAD=''
	local index argument
	for index in "${!ARGS[@]}"; do
		argument="${ARGS[$index]}"
		if [[ "$argument" == --command=* ]]; then
			PAYLOAD="${argument#--command=} ${ARGS[*]:$((index + 1))}"
		elif [[ "$argument" == --command ]] \
			|| [[ "$argument" != --* && "$argument" == -*c* ]]; then
			PAYLOAD="${ARGS[*]:$((index + 1))}"
		else
			continue
		fi
		PAYLOAD="${PAYLOAD//\'/}"
		PAYLOAD="${PAYLOAD//\"/}"
		return 0
	done
	return 1
}

is_delegating() {
	[[ "$EXECUTABLE" =~ ^(ansible|ansible-playbook|doas|mosh|pkexec|run0|ssh|sudo|systemd-run)$ ]] && return 0
	if [[ "$EXECUTABLE" =~ ^(buildah|docker|kubectl|machinectl|nerdctl|podman|service|systemctl)$ ]]; then
		is_read_only_diagnostic && return 1
		return 0
	fi
	if [[ "$EXECUTABLE" =~ ^(bash|dash|fish|sh|zsh)$ ]]; then
		shell_command_payload && return 0
	fi
	return 1
}

is_read_only_diagnostic() {
	local first='' second='' argument
	for argument in "${ARGS[@]}"; do
		[[ "$argument" == -* ]] && continue
		if [[ -z "$first" ]]; then
			first="$argument"
			continue
		fi
		second="$argument"
		break
	done
	case "$EXECUTABLE" in
	systemctl) [[ "$first" =~ ^(cat|get-default|is-active|is-enabled|is-failed|list-|show|status) ]] ;;
	kubectl) [[ "$first" =~ ^(api-resources|api-versions|auth|cluster-info|describe|explain|get|logs|top|version)$ ]] ;;
	docker | nerdctl | podman) [[ "$first" =~ ^(diff|events|history|images|info|inspect|logs|port|ps|stats|top|version)$ ]] ;;
	buildah) [[ "$first" =~ ^(containers|images|info|inspect|version)$ ]] ;;
	machinectl) [[ "$first" =~ ^(list|show|status)$ ]] ;;
	service) [[ "$second" == status ]] ;;
	*) return 1 ;;
	esac
}

is_trusted_runner() {
	case "$EXECUTABLE_TOKEN" in
	agentkit-run | '$HOME/.local/bin/agentkit-run' | '~/.local/bin/agentkit-run' | ./.claude/tools/agentkit-run)
		return 0
		;;
	/home/*/.local/bin/agentkit-run | */plugins/*/tools/agentkit-run) return 0 ;;
	*) return 1 ;;
	esac
}

unwrap_environment() {
	local index=0
	[[ "$EXECUTABLE" == env ]] || return 0
	while [[ "${ARGS[$index]:-}" == -* \
		|| "${ARGS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
		index=$((index + 1))
	done
	[[ -n "${ARGS[$index]:-}" ]] || return 0
	EXECUTABLE="${ARGS[$index]##*/}"
	ARGS=("${ARGS[@]:$((index + 1))}")
}

parse_wrapped_launch() {
	local index
	for index in "${!ARGS[@]}"; do
		if [[ "${ARGS[$index]}" == -- && -n "${ARGS[$((index + 1))]:-}" ]]; then
			EXECUTABLE="${ARGS[$((index + 1))]##*/}"
			EXECUTABLE_TOKEN="${ARGS[$((index + 1))]}"
			ARGS=("${ARGS[@]:$((index + 2))}")
			return 0
		fi
	done
	return 1
}

analyze_command() {
	local command="$1"
	local depth="$2"
	local segments segment
	((depth <= 3)) || deny "shell nesting exceeds analysis depth: $command"
	segments=$(printf '%s\n' "$command" | split_segments) \
		|| deny 'command could not be parsed safely'
	while IFS= read -r segment; do
		[[ -n "$segment" ]] || continue
		parse_launch "$segment"
		if [[ "$EXECUTABLE" == agentkit-run ]]; then
			if ! is_trusted_runner; then deny "$segment" delegated; fi
			if parse_wrapped_launch; then
				unwrap_environment
				if is_delegating && [[ "$DELEGATED_OK" != 1 ]]; then
					deny "$segment" delegated
				fi
			fi
			continue
		fi
		if [[ "$EXECUTABLE" =~ ^(bash|dash|fish|sh|zsh)$ ]] && shell_command_payload; then
			analyze_command "$PAYLOAD" $((depth + 1))
			continue
		fi
		if is_delegating && [[ "$DELEGATED_OK" != 1 ]]; then
			deny "$segment" delegated
		fi
		if is_heavy; then deny "$segment"; fi
	done <<<"$segments"
}

declare EXECUTABLE EXECUTABLE_TOKEN PAYLOAD
declare -a TOKENS ARGS
analyze_command "$COMMAND" 0

exit 0
