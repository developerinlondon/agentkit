#!/usr/bin/env bash
# SessionStart (brain kit): surface every memory vault index the agent can reach.
# No vault → silent no-op, so the hook is safe to ship globally.
set -euo pipefail

cat >/dev/null

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/brain-config.sh"

agentkit_brain_flag memory enabled || exit 0

vaults="$(agentkit_memory_vaults)"
[[ -n "$vaults" ]] || exit 0

printf 'Memory vault index — read the relevant files before acting:\n'
while IFS=$'\t' read -r scope dir; do
	[[ -n "$dir" ]] || continue
	index="$dir/index.md"
	[[ -f "$index" ]] || continue
	printf '\n## %s vault (%s)\n\n' "$scope" "$dir"
	cat "$index"
done <<<"$vaults"
