#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

deny() {
	local segment="$1"
	local kind="${2:-heavy}"
	local reason
	if [[ "$kind" == delegated ]]; then
		reason="BLOCKED: delegated workload cannot be contained by agentkit-run: $segment. Use a separately approved dedicated runner or verified engine-native limits."
	else
		reason="BLOCKED: resource-intensive command is not contained: $segment. Run it through agentkit-run, for example: agentkit-run --profile compile -- bun run typecheck. Use profile browser for Playwright and browser builds."
	fi
	jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
	exit 0
}

split_segments() {
	awk '
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
            (character == ";" || character == "|" || pair == "&&")) {
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
	while [[ "${TOKENS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
		index=$((index + 1))
	done
	token="${TOKENS[$index]:-}"
	if [[ "${token##*/}" == sudo ]]; then
		index=$((index + 1))
		while [[ "${TOKENS[$index]:-}" == -* ]]; do index=$((index + 1)); done
	fi
	token="${TOKENS[$index]:-}"
	if [[ "${token##*/}" == env ]]; then
		index=$((index + 1))
		while [[ "${TOKENS[$index]:-}" == -* \
			|| "${TOKENS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
			index=$((index + 1))
		done
	fi
	while [[ "${TOKENS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
		index=$((index + 1))
	done
	token="${TOKENS[$index]:-}"
	EXECUTABLE="${token##*/}"
	ARGS=("${TOKENS[@]:$((index + 1))}")
}

is_heavy() {
	local executable="${EXECUTABLE,,}"
	local first="${ARGS[0]:-}"
	local second="${ARGS[1]:-}"
	case "$executable" in
	bun)
		[[ "$first" =~ ^(add|install|update|test)$ ]] && return 0
		[[ "$first" == run && "$second" =~ ^(build|check|type-?check|lint|test(:[[:alnum:]_-]+)?)$ ]]
		;;
	bunx)
		[[ "$first" == tsc && "$second" != --version ]] \
			|| [[ "$first" == playwright && "$second" == test ]]
		;;
	tsc) [[ "$first" != --version ]] ;;
	playwright) [[ "$first" == test ]] ;;
	cargo) [[ "$first" =~ ^(build|check|test|clippy)$ ]] ;;
	go) [[ "$first" =~ ^(build|test)$ ]] ;;
	pytest) return 0 ;;
	python | python3) [[ "$first" == -m && "$second" == pytest ]] ;;
	*) return 1 ;;
	esac
}

is_delegating() {
	[[ "$EXECUTABLE" == systemd-run ]] && return 0
	[[ "$EXECUTABLE" =~ ^(docker|podman)$ && "${ARGS[0]:-}" == build ]] && return 0
	if [[ "$EXECUTABLE" =~ ^(bash|sh|zsh)$ ]]; then
		local argument
		for argument in "${ARGS[@]}"; do
			[[ "$argument" == -c || "$argument" == -lc ]] && return 0
		done
	fi
	return 1
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
			ARGS=("${ARGS[@]:$((index + 2))}")
			return 0
		fi
	done
	return 1
}

declare EXECUTABLE
declare -a TOKENS ARGS
SEGMENTS=$(printf '%s\n' "$COMMAND" | split_segments) \
	|| deny 'command could not be parsed safely'
while IFS= read -r segment; do
	parse_launch "$segment"
	if [[ "$EXECUTABLE" == agentkit-run ]]; then
		if parse_wrapped_launch; then
			unwrap_environment
			if is_delegating; then deny "$segment" delegated; fi
		fi
		continue
	fi
	if is_delegating; then deny "$segment" delegated; fi
	if is_heavy; then deny "$segment"; fi
done <<<"$SEGMENTS"

exit 0
