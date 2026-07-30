#!/usr/bin/env bash
# PostToolUse Edit|Write (memory kit): keep brain/index.md agreeing with the
# files on disk. Deterministic — bare wikilinks grouped by top-level directory,
# no generated prose. Names are never fed to a regex engine, headers avoid
# bash-4-only expansions, and the index is replaced atomically: this file
# rewrites user memory, so a mid-run failure must leave the old index intact.
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

indexed="$(grep -o '\[\[[^]]*\]\]' "$index" | sed 's/^\[\[//; s/\]\]$//' | sort || true)"

[[ "$disk" == "$indexed" ]] && exit 0

dirs="$(awk -F/ 'NF>1{print $1}' <<<"$disk" | sort -u)"

tmp="$(mktemp "$brain_dir/.index-rebuild.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
	echo "# Brain"
	while IFS= read -r section; do
		[[ -n "$section" ]] || continue
		first="$(printf '%s' "${section:0:1}" | LC_ALL=C tr '[:lower:]' '[:upper:]')"
		printf '\n## %s%s\n' "$first" "${section:1}"
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
mv "$tmp" "$index"
trap - EXIT
