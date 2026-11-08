#!/usr/bin/env bash
# Usage: cached-ok.sh <.prototools>
# Exits 0 when every tool pinned in the file answers --version with its pinned
# version on PATH, 1 otherwise. A stale or partial cache must not be used.
set -uo pipefail
ok=0
while IFS='=' read -r tool version; do
	tool="$(printf '%s' "$tool" | tr -d ' ')"
	version="$(printf '%s' "${version:-}" | tr -d ' "')"
	[ -n "$tool" ] || continue
	case "$tool" in \#*) continue ;; \[*) break ;; esac
	found="$("$tool" --version 2>/dev/null | head -n 1)"
	case "$found" in
	*"$version"*) printf 'cached %s %s\n' "$tool" "$version" ;;
	*)
		printf "cached %s answered '%s', expected %s\n" "$tool" "$found" "$version"
		ok=1
		;;
	esac
done <"$1"
exit "$ok"
