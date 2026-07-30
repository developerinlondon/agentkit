#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
TOKEN_FILE="${AGENTKIT_SITE_TOKEN_FILE:-$HOME/.config/agentkit/site-token}"
ENDPOINT="${AGENTKIT_PAGES_ENDPOINT:-https://pages.agentkit.sbs}"
SITE_URL="${AGENTKIT_SITE_URL:-https://agentkit.sbs}"
[[ -f "$TOKEN_FILE" ]] || { echo "deploy: site token missing at $TOKEN_FILE" >&2; exit 1; }

./build.sh

# Read from the build rather than re-derived: this is the value stamped into the
# pages. A dirty tree builds as <sha>-dirty, which will not match and should not.
SHA_FILE=site/.build-sha
[[ -s "$SHA_FILE" ]] || { echo "deploy: $SHA_FILE is missing — build.sh did not finish" >&2; exit 1; }
expected=$(cat "$SHA_FILE")

# Refused explicitly, not left to the comparison: deriving the expected value
# from the build made a dirty deploy self-consistent, so it passed while meaning
# "the site serves the build I just made" rather than "it serves this commit".
if [[ "$expected" == *-dirty && "${AGENTKIT_ALLOW_DIRTY_DEPLOY:-}" != 1 ]]; then
	echo "deploy: refusing to publish a dirty build ($expected)" >&2
	echo "  commit or stash the working tree, or set AGENTKIT_ALLOW_DIRTY_DEPLOY=1" >&2
	exit 1
fi

# curl reads the credential from a file rather than argv: a bearer token on a
# command line is readable by every other process on the host.
umask 077
auth=$(mktemp)
trap 'rm -f "$auth"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" > "$auth"

# The slug is a pure transform of the built path, so a page added later uploads
# without this script being touched: site/index.html -> _site, and
# site/<path>/index.html -> _site/<path>. A hardcoded page list would instead
# skip a new page silently.
deployed=0
urls=()
while IFS= read -r page; do
	rel=${page#site/}
	if [[ "$rel" == index.html ]]; then
		slug=_site
		path=
	else
		path=${rel%/index.html}
		slug="_site/$path"
	fi

	if ! body=$(curl -sS --fail-with-body -X PUT \
		--config "$auth" --data-binary "@$page" "$ENDPOINT/api/pages/$slug" 2>&1); then
		echo "deploy: FAILED $page -> $slug" >&2
		echo "$body" >&2
		exit 1
	fi

	echo "deployed: $SITE_URL/$path"
	urls+=("$SITE_URL/$path")
	deployed=$((deployed + 1))
	# Root last, deliberately rather than by sort accident: if the walk dies
	# part-way the front page still points at the previous, coherent set.
done < <({ find site -mindepth 2 -name index.html | sort; echo site/index.html; })

# An empty build would otherwise report success having uploaded nothing.
[[ "$deployed" -gt 0 ]] || { echo "deploy: no pages found under site/" >&2; exit 1; }
echo "deploy: $deployed page(s)"


# The worker occasionally serves the previous object, or the 404 page, for a
# moment after a write. Retry a fixed few times so a correct deploy is not
# reported broken, then fail — an unbounded wait would hide a real failure.
ATTEMPTS=${AGENTKIT_VERIFY_ATTEMPTS:-5}
DELAY=${AGENTKIT_VERIFY_DELAY:-2}

# Under pipefail a grep that matches nothing fails the whole substitution, and
# set -e would end the run before the retry ever happened. "Not there yet" is a
# value here, not an error.
served_sha() {
	curl -sS --max-time 15 "$1" 2>/dev/null \
		| grep -o 'name="build-sha" content="[^"]*"' | head -1 | cut -d'"' -f4 || true
}

verified=0
for url in "${urls[@]}"; do
	got=
	for ((try = 1; try <= ATTEMPTS; try++)); do
		got=$(served_sha "$url")
		# Not `cond && action`: a false test at the tail of the body leaks its
		# status out of the loop, and set -e then kills the retry silently.
		if [[ "$got" == "$expected" ]]; then break; fi
		if [[ "$try" -lt "$ATTEMPTS" ]]; then sleep "$DELAY"; fi
	done
	if [[ "$got" != "$expected" ]]; then
		echo "deploy: VERIFY FAILED for $url" >&2
		echo "  expected build-sha: $expected" >&2
		echo "  served build-sha:   ${got:-<none — no build-sha in the response>}" >&2
		if [[ "$got" == *-dirty ]]; then
			echo "  the build was made from a dirty tree, so it is not that commit's bytes" >&2
		fi
		echo "  after $ATTEMPTS attempts ${DELAY}s apart" >&2
		exit 1
	fi
	verified=$((verified + 1))
done

echo "verified: $verified page(s) serving build $expected"
