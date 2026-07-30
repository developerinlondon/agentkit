#!/usr/bin/env bash
# PostToolUse Edit|Write (memory kit): keep brain/index.md agreeing with the
# files on disk. Deterministic — bare wikilinks grouped by top-level directory,
# no generated prose. Only fires for writes inside brain/ of a project that
# already has an index; everything else exits untouched.
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

case "$file_path" in
"$brain_dir"/* | brain/*) ;;
*) exit 0 ;;
esac

disk=$(find "$brain_dir" -name "*.md" ! -name "index.md" -type f \
	| sed "s|^${brain_dir}/||; s|\.md$||" \
	| sort)

indexed=$(sed -n 's/.*\[\[\([^]]*\)\]\].*/\1/p' "$index" | sort)

[[ "$disk" == "$indexed" ]] && exit 0

emit_files() {
	while IFS= read -r f; do
		[[ -z "$f" ]] && continue
		echo "- [[$f]]"
	done
}

dirs=$(echo "$disk" | grep '/' | sed 's|/.*||' | sort -u || true)

{
	echo "# Brain"
	for section in $dirs; do
		files=$(echo "$disk" | grep "^${section}\(/\|$\)" || true)
		[[ -z "$files" ]] && continue
		printf '\n## %s\n' "${section^}"
		echo "$files" | emit_files
	done
	standalone=$(echo "$disk" | grep -v '/' || true)
	if [[ -n "$standalone" ]]; then
		printf '\n## Other\n'
		echo "$standalone" | emit_files
	fi
	echo ""
} >"$index"
