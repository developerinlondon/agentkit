#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

TOKEN_FILE="${AGENTKIT_SITE_TOKEN_FILE:-$HOME/.config/agentkit/site-token}"
ENDPOINT="${AGENTKIT_PAGES_ENDPOINT:-https://pages.agentkit.sbs}"
SITE_URL="${AGENTKIT_SITE_URL:-https://agentkit.sbs}"
STAMP=dist/build-sha.txt

[[ -f "$TOKEN_FILE" ]] || {
	echo "deploy: site token missing at $TOKEN_FILE" >&2
	exit 1
}

sha=$(git rev-parse --short=8 HEAD)
if [[ -n "$(git status --porcelain)" ]]; then
	sha="$sha-dirty"
fi

# Refused explicitly rather than left to the comparison: the stamp is uploaded
# from the same build it describes, so a dirty deploy would verify against
# itself and report "live" for a commit that does not exist anywhere.
if [[ "$sha" == *-dirty && "${AGENTKIT_ALLOW_DIRTY_DEPLOY:-}" != 1 ]]; then
	echo "deploy: refusing to publish a dirty build ($sha)" >&2
	echo "  commit the working tree, or set AGENTKIT_ALLOW_DIRTY_DEPLOY=1" >&2
	exit 1
fi

node ./node_modules/astro/bin/astro.mjs build

# Checked before the stamp is written: a failed build leaves no dist/ at all, and
# writing the stamp first turns that into a confusing redirection error instead
# of a plain report that there is nothing to publish.
built=0
if [[ -d dist ]]; then
	built=$(find dist -type f | wc -l | tr -d ' ')
fi
[[ "$built" -gt 0 ]] || {
	echo "deploy: dist/ holds no built site" >&2
	exit 1
}

printf '%s\n' "$sha" > "$STAMP"

# curl reads the credential from a file rather than argv: a bearer token on a
# command line is readable by every other process on the host.
umask 077
auth=$(mktemp)
trap 'rm -f "$auth"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" > "$auth"

put() {
	local file=$1 rel=${1#dist/} body
	if ! body=$(curl -sS --fail-with-body -X PUT \
		--config "$auth" --data-binary "@$file" "$ENDPOINT/api/site/docs/$rel" 2>&1); then
		echo "deploy: FAILED $file -> docs/$rel" >&2
		echo "$body" >&2
		exit 1
	fi
}

# Assets before documents, and the stamp last: a walk that dies part-way leaves
# the previously deployed pages intact and still pointing at assets that exist,
# and never claims a version it did not finish uploading.
uploaded=0
while IFS= read -r file; do
	put "$file"
	uploaded=$((uploaded + 1))
done < <(find dist -type f ! -name '*.html' ! -path "$STAMP" | sort)

while IFS= read -r file; do
	put "$file"
	uploaded=$((uploaded + 1))
done < <(find dist -type f -name '*.html' | sort)

put "$STAMP"
echo "deploy: $((uploaded + 1)) file(s) at $sha"

# The worker occasionally serves the previous object for a moment after a write.
# Retry a fixed few times so a correct deploy is not reported broken, then fail —
# an unbounded wait would hide a real failure.
for attempt in 1 2 3 4 5 6; do
	live=$(curl -sS "$SITE_URL/docs/build-sha.txt" 2>/dev/null | tr -d '[:space:]' || true)
	[[ "$live" == "$sha" ]] && break
	if [[ "$attempt" == 6 ]]; then
		echo "deploy: $SITE_URL/docs/ serves '$live', expected '$sha'" >&2
		exit 1
	fi
	sleep 2
done

for path in "" getting-started/install/; do
	code=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE_URL/docs/$path")
	[[ "$code" == 200 ]] || {
		echo "deploy: $SITE_URL/docs/$path returned $code" >&2
		exit 1
	}
done

echo "deploy: verified live at $SITE_URL/docs/ ($sha)"
