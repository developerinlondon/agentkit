#!/usr/bin/env bash
# Publishes the built docs to the worker and removes what is no longer part of
# them. Every path is under `docs/`, which is the only prefix the worker's asset
# API will accept.
set -euo pipefail
cd "$(dirname "$0")"

ENDPOINT="${AGENTKIT_SITE_ENDPOINT:-https://agentkit.sbs}"
DOCS_URL="${AGENTKIT_DOCS_URL:-https://docs.agentkit.sbs}"
TOKEN_FILE="${AGENTKIT_SITE_TOKEN_FILE:-$HOME/.config/agentkit/site-token}"
MARKER='ak-theme-toggle'
# Slugs published under /docs/<version>/, which this build does not contain and
# which the prune must therefore spare.
keep=archives.txt

die() {
	echo "deploy: $*" >&2
	exit 1
}

[[ -f "$TOKEN_FILE" ]] || die "no site token at $TOKEN_FILE"
[[ -d public ]] || die "no public/ — run ./build.sh first"

umask 077
auth=$(mktemp)
live=$(mktemp)
built=$(mktemp)
stale=$(mktemp)
trap 'rm -f "$auth" "$live" "$built" "$stale"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" > "$auth"

# Upload before pruning: a half-finished upload that had already deleted the
# previous copy would leave the docs missing rather than merely stale.
uploaded=0
while IFS= read -r file; do
	rel="docs/${file#public/}"
	if ! body=$(curl -sS --fail-with-body -X PUT \
		--config "$auth" --data-binary "@$file" "$ENDPOINT/api/site/$rel" 2>&1); then
		echo "$body" >&2
		die "FAILED $file -> $rel"
	fi
	uploaded=$((uploaded + 1))
done < <(find public -type f)
[[ "$uploaded" -gt 0 ]] || die "public/ holds no files"
echo "deploy: uploaded $uploaded file(s)"

# A release also lands under its own version, so the copy stays readable once
# /docs/ moves on. It is rebuilt against its own base: Hugo content-hashes the
# stylesheet name, so a copy pointing at /docs/ loses every asset the moment the
# next release changes that hash.
version="${AGENTKIT_DOCS_VERSION:-}"
version="${version#v}"
if [[ -n "$version" ]]; then
	archive=$(mktemp -d)
	"${HUGO_BIN:-hugo-extended}" --quiet --destination "$archive" \
		--baseURL "$DOCS_URL/$version/" || die "could not build the $version archive"
	while IFS= read -r file; do
		curl -sS --fail-with-body -X PUT --config "$auth" --data-binary "@$file" \
			"$ENDPOINT/api/site/docs/$version/${file#"$archive"/}" >/dev/null \
			|| die "FAILED $file -> docs/$version/"
	done < <(find "$archive" -type f)
	rm -rf "$archive"
	echo "deploy: also published $DOCS_URL/$version/"
	printf '%s\n' "$version" >> "$keep"
fi

# Archives are published once and never rebuilt, so they are absent from this
# build and would otherwise read as stale on every deploy.
if ! curl -sS --fail-with-body --config "$auth" "$ENDPOINT/api/site-list/docs/" > "$live.json" 2>/dev/null; then
	die "could not list what is live — not pruning"
fi
tr ',' '\n' < "$live.json" | grep -oE '"docs/[^"]+"' | tr -d '"' | sort -u > "$live"
rm -f "$live.json"
(cd public && find . -type f | sed 's|^\./|docs/|') | sort -u > "$built"
comm -23 "$live" "$built" > "$stale"

if [[ -s "$keep" ]]; then
	spare=$(mktemp)
	sed 's/\./\\./g; s|.*|^docs/&/|' "$keep" > "$spare"
	grep -vEf "$spare" "$stale" > "$stale.kept" || true
	mv "$stale.kept" "$stale"
	rm -f "$spare"
fi

stale_count=$(grep -c . "$stale" || true)
if [[ "${stale_count:-0}" -gt 0 ]]; then
	echo "deploy: removing $stale_count object(s) no longer in the build"
	# Deletions are independent of each other, and a cutover can leave thousands
	# behind; serially they would outlast the job that runs them.
	xargs -P 8 -I{} curl -sS -o /dev/null -X DELETE --config "$auth" \
		"$ENDPOINT/api/site/{}" < "$stale"
fi

# Proves the bytes that answer are this build's, not a cached previous copy.
# Retried because the worker serves the previous object for a moment after a
# write, and a large prune widens that window — failing on the first read would
# report a correct deploy as broken.
# Fetched to a file rather than piped into grep: `grep -q` closes the pipe on
# its first match, curl then dies of SIGPIPE, and pipefail reports a successful
# deploy as a failed one.
served=$(mktemp)
trap 'rm -f "$auth" "$live" "$built" "$stale" "$served"' EXIT
attempts=${AGENTKIT_VERIFY_ATTEMPTS:-6}
for ((try = 1; try <= attempts; try++)); do
	if curl -sS --max-time 20 -o "$served" "$DOCS_URL/" 2>/dev/null && grep -q "$MARKER" "$served"; then
		echo "deploy: $DOCS_URL/ is serving this build"
		exit 0
	fi
	if [[ "$try" -lt "$attempts" ]]; then sleep 3; fi
done
die "published, but $DOCS_URL/ still does not serve this build after $attempts attempts"
