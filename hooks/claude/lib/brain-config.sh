#!/usr/bin/env bash
# Config and vault resolution shared by the brain kit's hooks. Units live under a
# `brain:` banner so memory and taste share a namespace without sharing a store.

agentkit_brain_flag() {
	local unit="$1" key="$2" value file
	for file in \
		"${CLAUDE_PROJECT_DIR:-$PWD}/.agentkit/config.yaml" \
		"${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"; do
		[[ -f "$file" ]] || continue
		value="$(awk -v unit="$unit" -v want="$key" '
			/^[^[:space:]#]/ { in_brain = ($0 ~ /^brain:/); in_unit = 0; next }
			!in_brain { next }
			{
				line = $0
				sub(/[[:space:]]*#.*$/, "", line)
				if (line ~ /^[[:space:]]*$/) next
				match(line, /^[[:space:]]*/); indent = RLENGTH
				sub(/^[[:space:]]+/, "", line)
				if (indent <= 2) { in_unit = (line == unit ":"); next }
				if (!in_unit) next
				if (line !~ /^[a-z-]+:[[:space:]]*(true|false)[[:space:]]*$/) next
				k = line; sub(/:.*/, "", k)
				if (k != want) next
				sub(/^[^:]*:[[:space:]]*/, "", line)
				print line; exit
			}
		' "$file" 2>/dev/null || true)"
		if [[ -n "$value" ]]; then
			[[ "$value" == "true" ]]
			return
		fi
	done
	return 0
}

# User scope first, repository second: the repository's vault is the more specific
# and reads last, closest to the work.
agentkit_memory_vaults() {
	local user="$HOME/.agentkit/memory" repo="${CLAUDE_PROJECT_DIR:-$PWD}/memory"
	[[ -d "$user" ]] && printf 'user\t%s\n' "$user"
	[[ "$repo" != "$user" && -d "$repo" ]] && printf 'repository\t%s\n' "$repo"
	return 0
}
