#!/usr/bin/env bash
# SessionStart (brain kit): surface every memory vault index the agent can reach.
# No vault → silent no-op, so the hook is safe to ship globally.
set -euo pipefail

cat >/dev/null

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/brain-config.sh"

agentkit_brain_flag memory enabled || exit 0

vaults="$(agentkit_memory_vaults)"
[[ -n "$vaults" ]] || exit 0

# Sources are read from disk rather than from the index, which is rebuilt only
# when a note is written: a source a sync added would otherwise stay invisible
# until someone happened to edit one.
external_sources() {
	local vault="$1" dir name count
	[[ -d "$vault/external" ]] || return 0
	printf '\n### External sources — read-only snapshots, pinned in the lock\n\n'
	for dir in "$vault"/external/*/; do
		[[ -d "$dir" ]] || continue
		name="$(basename "$dir")"
		count="$(find "$dir" -name '*.md' -type f | wc -l | tr -d ' ')"
		printf -- '- %s — %s note%s at %s\n' "$name" "$count" "$([[ "$count" == 1 ]] || echo s)" "${dir%/}"
	done
}

printf 'Memory vault index — read the relevant files before acting:\n'
while IFS=$'\t' read -r scope dir; do
	[[ -n "$dir" ]] || continue
	index="$dir/index.md"
	[[ -f "$index" ]] || continue
	printf '\n## %s vault (%s)\n\n' "$scope" "$dir"
	cat "$index"
	external_sources "$dir"
done <<<"$vaults"
