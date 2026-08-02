#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

TOKEN_FILE="${AGENTKIT_SITE_TOKEN_FILE:-$HOME/.config/agentkit/site-token}"
ENDPOINT="${AGENTKIT_SITE_ENDPOINT:-https://agentkit.sbs}"
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

# Archived versions build from their own tags into dist/<slug>/ — a declared
# version that fails to build fails the deploy, naming its tag. Reuse is enabled
# here and nowhere else: a local build must keep producing the whole site, or the
# only place the archives are exercised is the one place that skips them.
AGENTKIT_ARCHIVE_REUSE=1 ./build-archives.sh dist
REUSED=dist/.reused-archives

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
done < <(find dist -type f ! -name '*.html' ! -path "$STAMP" ! -name .reused-archives | sort)

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

# Uploading never removes: before this, a page deleted from the build kept
# answering 200 and nothing reported it. Ten migration redirects had to be deleted
# by hand once for exactly that reason.
#
# The failure direction is chosen deliberately. Deleting the wrong object is worse
# than keeping a stale one, so an implausible diff refuses instead of pruning: a
# listing that fails, or one that would remove more than half of what is live,
# stops the deploy rather than guessing.
#
# Key lists live in files rather than arrays: under `set -u`, bash 3.2 treats
# "${empty[@]}" as an unbound variable, and macOS ships 3.2.
live_keys=$(mktemp)
built_keys=$(mktemp)
stale_keys=$(mktemp)
trap 'rm -f "$auth" "$live_keys" "$built_keys" "$stale_keys"' EXIT

# The fetch is checked on its own: piping it straight into a filter conflates "the
# listing failed" with "the listing was empty", because grep exits 1 on no match
# and pipefail then reports the whole pipeline as failed.
listing=$(mktemp)
if ! curl -sS --fail-with-body --config "$auth" "$ENDPOINT/api/site-list/docs/" > "$listing" 2>/dev/null; then
	echo "deploy: could not list what is live — not pruning" >&2
	exit 1
fi
tr ',' '\n' < "$listing" | grep -oE '"docs/[^"]+"' | tr -d '"' | sort -u > "$live_keys" || true
rm -f "$listing"
(cd dist && find . -type f | sed 's|^\./|docs/|') | sort -u > "$built_keys"
comm -23 "$live_keys" "$built_keys" > "$stale_keys"

# A reused archive is deliberately absent from dist/, so every one of its live
# objects looks stale here. Spare exactly the slugs this run reused — dots
# escaped so `0.5.3` cannot bless `0X5X3` — and do it before the refusal below,
# which would otherwise measure a deletion nobody proposed. A slug dropped from
# the selection is in neither list and prunes normally.
if [[ -s "$REUSED" ]]; then
	keep_re=$(mktemp)
	kept=$(mktemp)
	sed 's/\./\\./g; s|.*|^docs/&/|' "$REUSED" > "$keep_re"
	grep -vEf "$keep_re" "$stale_keys" > "$kept" || true
	mv "$kept" "$stale_keys"
	rm -f "$keep_re"
	echo "deploy: kept $(grep -c . "$REUSED" || true) reused archive(s) out of the prune"
fi

stale_count=$(grep -c . "$stale_keys" || true)
live_count=$(grep -c . "$live_keys" || true)
if [[ "${stale_count:-0}" -gt 0 ]]; then
	if [[ "$stale_count" -gt $((live_count / 2)) ]]; then
		echo "deploy: refusing to prune $stale_count of $live_count live objects — that is not a redeploy" >&2
		sed 's/^/  /' "$stale_keys" >&2
		exit 1
	fi
	while IFS= read -r key; do
		[[ -n "$key" ]] || continue
		curl -sS --fail-with-body -X DELETE --config "$auth" "$ENDPOINT/api/site/$key" >/dev/null 2>&1 \
			|| { echo "deploy: failed to prune $key" >&2; exit 1; }
		echo "pruned: $key"
	done < "$stale_keys"
	echo "deploy: pruned $stale_count object(s) no longer in the build"
else
	echo "deploy: nothing to prune"
fi

echo "deploy: verified live at $SITE_URL/docs/ ($sha)"
