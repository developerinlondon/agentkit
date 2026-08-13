#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

HUGO="${HUGO_BIN:-hugo-extended}"
command -v "$HUGO" >/dev/null || {
	echo "build: $HUGO not on PATH — Hextra needs Hugo extended >= 0.146" >&2
	exit 1
}

bun scripts/facts.ts
bun scripts/versions.ts

rm -rf public
"$HUGO" --logLevel warn --gc --minify

# Hugo does not check links, so a renamed page would ship dangling hrefs.
bun scripts/check-links.ts
