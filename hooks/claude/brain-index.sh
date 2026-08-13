#!/usr/bin/env bash
# PostToolUse Edit|Write (memory kit): keep brain/index.md agreeing with the
# files on disk. Deterministic — bare wikilinks grouped by top-level directory,
# no generated prose. Names are never fed to a regex engine, headers avoid
# bash-4-only expansions, and the index is replaced atomically and only when
# its content actually changes: this file rewrites user memory, so a mid-run
# failure must leave the old index intact.
set -euo pipefail

# shellcheck source=lib/hook-input.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/hook-input.sh"
agentkit_slurp_input

file_path="$(agentkit_file_path)"
[[ -n "$file_path" ]] || exit 0

root="${CLAUDE_PROJECT_DIR:-$PWD}"
brain_dir="$root/brain"
index="$brain_dir/index.md"
[[ -f "$index" ]] || exit 0

[[ "$file_path" != /* ]] && file_path="$PWD/$file_path"
case "$file_path" in
"$brain_dir"/*) ;;
*) exit 0 ;;
esac

disk="$(cd "$brain_dir" && find . -name '*.md' ! -name 'index.md' -type f \
	| sed 's|^\./||; s|\.md$||' \
	| sort)"

dirs="$(awk -F/ 'NF>1{print $1}' <<<"$disk" | sort -u)"

# The index is injected into every session, so one line per note grows it without
# bound. Past this, a section is summarised rather than listed. 0 disables.
max_per_section="${AGENTKIT_BRAIN_INDEX_MAX_PER_SECTION:-20}"
case "$max_per_section" in
'' | *[!0-9]*) max_per_section=20 ;;
esac

tmp="$(mktemp "$brain_dir/.index-rebuild.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
	echo "# Brain"
	while IFS= read -r section; do
		[[ -n "$section" ]] || continue
		first="$(printf '%s' "${section:0:1}" | LC_ALL=C tr '[:lower:]' '[:upper:]')"
		printf '\n## %s%s\n' "$first" "${section:1}"
		count=0
		while IFS= read -r f; do
			case "$f" in "$section"/*) count=$((count + 1)) ;; esac
		done <<<"$disk"
		if [[ "$max_per_section" -gt 0 && "$count" -gt "$max_per_section" ]]; then
			printf -- '- %s notes — `ls brain/%s/` then read what matches\n' "$count" "$section"
			continue
		fi
		while IFS= read -r f; do
			case "$f" in "$section"/*) echo "- [[$f]]" ;; esac
		done <<<"$disk"
	done <<<"$dirs"
	other=false
	while IFS= read -r f; do
		[[ -n "$f" ]] || continue
		case "$f" in */*) continue ;; esac
		if [[ "$other" == false ]]; then
			printf '\n## Other\n'
			other=true
		fi
		echo "- [[$f]]"
	done <<<"$disk"
	echo ""
} >"$tmp"
# Exact no-op on agreement for every possible note name: the index is never
# parsed, only compared whole.
cmp -s "$tmp" "$index" || mv "$tmp" "$index"
trap - EXIT
rm -f "$tmp"
