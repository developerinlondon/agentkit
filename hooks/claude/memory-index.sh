#!/usr/bin/env bash
# PostToolUse Edit|Write (brain kit): keep a memory vault's index.md agreeing with
# the files on disk. This rewrites user memory, so it is replaced atomically and
# only on a real change — a mid-run failure must leave the old index intact.
set -euo pipefail

hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/hook-input.sh
source "$hook_dir/lib/hook-input.sh"
# shellcheck source=lib/brain-config.sh
source "$hook_dir/lib/brain-config.sh"
agentkit_slurp_input

# Gates on `enabled` alone: an index that disagrees with the files beside it is
# wrong whoever wrote them, and `learning` governs whether notes are authored.
agentkit_brain_flag memory enabled || exit 0

file_path="$(agentkit_file_path)"
[[ -n "$file_path" ]] || exit 0
[[ "$file_path" != /* ]] && file_path="$PWD/$file_path"

vault_dir=""
while IFS=$'\t' read -r _ dir; do
	[[ -n "$dir" ]] || continue
	case "$file_path" in "$dir"/*) vault_dir="$dir" ;; esac
done <<<"$(agentkit_memory_vaults)"
[[ -n "$vault_dir" ]] || exit 0

index="$vault_dir/index.md"
[[ -f "$index" ]] || exit 0

# external/ holds a vendored source, listed by the injector rather than here: a
# whole knowledgebase indexed note by note is someone else's repository in this
# vault's index.
disk="$(cd "$vault_dir" && find . -path ./external -prune -o \
	-name '*.md' ! -name 'index.md' -type f -print \
	| sed 's|^\./||; s|\.md$||' \
	| sort)"

dirs="$(awk -F/ 'NF>1{print $1}' <<<"$disk" | sort -u)"

# The index is injected into every session, so one line per note grows it without
# bound. Past this, a section is summarised rather than listed. 0 disables.
max_per_section="${AGENTKIT_MEMORY_INDEX_MAX_PER_SECTION:-20}"
case "$max_per_section" in
'' | *[!0-9]*) max_per_section=20 ;;
esac

tmp="$(mktemp "$vault_dir/.index-rebuild.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
	echo "# Memory"
	while IFS= read -r section; do
		[[ -n "$section" ]] || continue
		first="$(printf '%s' "${section:0:1}" | LC_ALL=C tr '[:lower:]' '[:upper:]')"
		printf '\n## %s%s\n' "$first" "${section:1}"
		count=0
		while IFS= read -r f; do
			case "$f" in "$section"/*) count=$((count + 1)) ;; esac
		done <<<"$disk"
		if [[ "$max_per_section" -gt 0 && "$count" -gt "$max_per_section" ]]; then
			printf -- '- %s notes — `ls %s/%s/` then read what matches\n' "$count" "$(basename "$vault_dir")" "$section"
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
# Compared whole, never parsed, so agreement is an exact no-op for any note name.
cmp -s "$tmp" "$index" || mv "$tmp" "$index"
trap - EXIT
rm -f "$tmp"
