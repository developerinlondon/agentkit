#!/usr/bin/env bash
# Scalar config lookup for issue-police and mr-police. What a project requires of
# an issue or an MR is data the hook reads, so the agent never has to rediscover
# a taxonomy it could have been handed.

# Project config wins over the machine's, matching brain-config.
agentkit_forge_config() {
	local section="$1" want="$2" value file
	for file in \
		"${CLAUDE_PROJECT_DIR:-$PWD}/.agentkit/config.yaml" \
		"${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"; do
		[[ -f "$file" ]] || continue
		value="$(awk -v section="$section" -v want="$want" '
			/^[^[:space:]#]/ { in_section = ($0 == section ":"); next }
			!in_section { next }
			{
				line = $0
				sub(/[[:space:]]*#.*$/, "", line)
				if (line ~ /^[[:space:]]*$/) next
				sub(/^[[:space:]]+/, "", line)
				split(line, kv, ":")
				if (kv[1] != want) next
				value = substr(line, length(kv[1]) + 2)
				sub(/^[[:space:]]+/, "", value)
				sub(/[[:space:]]+$/, "", value)
				gsub(/^["'"'"']|["'"'"']$/, "", value)
				print value
				exit
			}
		' "$file" 2>/dev/null)"
		[[ -n "$value" ]] && {
			printf '%s' "$value"
			return 0
		}
	done
	return 1
}

agentkit_forge_config_or() {
	local section="$1" key="$2" fallback="$3" value
	value="$(agentkit_forge_config "$section" "$key" || true)"
	printf '%s' "${value:-$fallback}"
}

# Absent reads as off: a house policy not every repository shares is asked for.
agentkit_forge_flag() {
	local value
	value="$(agentkit_forge_config "$1" "$2" || true)"
	case "$value" in
	true | yes | on | 1) return 0 ;;
	esac
	return 1
}
