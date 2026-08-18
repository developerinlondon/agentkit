#!/usr/bin/env bash
# A short-lived cache for forge lookups shared by issue-police and mr-police.
# Staleness costs a wasted refresh, never a wrong refusal — see
# agentkit_forge_verify.

AGENTKIT_FORGE_CACHE_ROOT="${AGENTKIT_FORGE_CACHE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/agentkit/forge}"

agentkit_forge_cache_file() {
	local key="$1"
	printf '%s/%s' "$AGENTKIT_FORGE_CACHE_ROOT" "$(printf '%s' "$key" | tr -c 'A-Za-z0-9._-' '_')"
}

agentkit_file_mtime() {
	stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || printf '0'
}

# Prints the cached value when it is younger than <ttl> seconds.
agentkit_forge_cached() {
	local file age now
	file="$(agentkit_forge_cache_file "$1")"
	[[ -f "$file" ]] || return 1
	now="$(date +%s)"
	age=$((now - $(agentkit_file_mtime "$file")))
	[[ "$age" -lt "$2" ]] || return 1
	cat "$file"
}

agentkit_forge_store() {
	local file tmp
	file="$(agentkit_forge_cache_file "$1")"
	mkdir -p "$(dirname "$file")" 2>/dev/null || return 0
	tmp="$(mktemp "${file}.XXXXXX")" || return 0
	printf '%s' "$2" >"$tmp" && mv -f "$tmp" "$file" || rm -f "$tmp"
}

# Cached value for <key>, or the output of <command…> stored under it. An empty
# result is not cached — that is usually a failed call, and caching it would
# turn one network blip into an hour of wrong answers.
agentkit_forge_lookup() {
	local key="$1" ttl="$2" value
	shift 2
	if value="$(agentkit_forge_cached "$key" "$ttl")"; then
		printf '%s' "$value"
		return 0
	fi
	value="$("$@" 2>/dev/null)" || return 1
	[[ -n "$value" ]] || return 1
	agentkit_forge_store "$key" "$value"
	printf '%s' "$value"
}

# Re-runs <command…> and replaces the cache entry.
agentkit_forge_refresh() {
	local key="$1" value
	shift
	value="$("$@" 2>/dev/null)" || return 1
	[[ -n "$value" ]] || return 1
	agentkit_forge_store "$key" "$value"
	printf '%s' "$value"
}

# The gate every cache-backed refusal goes through: <predicate> is run against
# the cached value, and only a second failure against freshly fetched data is
# reported as a real one. Returns 0 when the check passes.
agentkit_forge_verify() {
	local key="$1" ttl="$2" predicate="$3" value
	shift 3
	value="$(agentkit_forge_lookup "$key" "$ttl" "$@")" || return 0
	"$predicate" "$value" && return 0
	value="$(agentkit_forge_refresh "$key" "$@")" || return 0
	"$predicate" "$value"
}
