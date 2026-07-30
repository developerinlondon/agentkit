#!/usr/bin/env bash
# SessionStart (memory kit): surface the project's brain vault index.
# No vault → silent no-op, so the hook is safe to ship globally.
set -euo pipefail

cat >/dev/null

root="${CLAUDE_PROJECT_DIR:-$PWD}"
index="$root/brain/index.md"
[[ -f "$index" ]] || exit 0

echo "Brain vault index — read the relevant files before acting:"
echo ""
cat "$index"
