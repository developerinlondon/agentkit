#!/usr/bin/env bash
# A file, not an inline postinstall: bun echoes that verbatim, so an inline
# fallback shows "lockfile is out of date" on every successful install.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if bun install --frozen-lockfile --cwd skills/publish-page; then
	exit 0
fi

echo "agentkit: skills/publish-page/bun.lock is out of date." >&2
echo "          run: bun install --cwd skills/publish-page, then commit that lockfile" >&2
exit 1
