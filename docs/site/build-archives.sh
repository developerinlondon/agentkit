#!/usr/bin/env bash
# Builds each archived docs version from its git tag into <dist>/<slug>/, with
# that tag's own content, dependencies and toolchain. Archives used to be page
# copies committed on main, which let current-code renames break or silently
# falsify a released version; a tag build cannot be reached by main at all.
set -euo pipefail
cd "$(dirname "$0")"

DIST="${1:-dist}"
LIST=src/lib/list-archives.ts
REPO_ROOT=$(git rev-parse --show-toplevel)

die() {
	echo "build-archives: $*" >&2
	exit 1
}

command -v bun >/dev/null || die "bun is required to derive the archive list"
[[ -d "$DIST" ]] || die "no $DIST — build the current docs first"
DIST_ABS=$(cd "$DIST" && pwd)

# Derived from the tags through the same module the picker renders from, and
# captured before the loop: a process substitution would swallow a derivation
# failure and read as "no archives", publishing a site whose picker offers
# versions that were never built.
ENTRIES=$(mktemp)
trap 'rm -f "$ENTRIES"' EXIT
bun "$LIST" > "$ENTRIES" || die "could not derive the archive list from $LIST"

while IFS=$'\t' read -r slug tag; do
	[[ "$slug" =~ ^[0-9][0-9.]*$ && "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
		|| die "derived entry is malformed: slug='$slug' tag='$tag'"
	git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null \
		|| die "tag $tag is not present — fetch tags before building archives"

	echo "[archive] $slug from $tag"
	tmp=$(mktemp -d)
	# A declared version that no longer builds must fail the pipeline naming
	# its tag — never vanish from the site without saying so.
	(
		trap 'git -C "$REPO_ROOT" worktree remove --force "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT
		git -C "$REPO_ROOT" worktree add --detach "$tmp" "$tag" >/dev/null
		cd "$tmp/docs/site"

		# The tag's tree believes it is the current docs at /docs. Mounting it
		# at /docs/<slug> needs its base and its absolute content links moved,
		# or every link walks out of the archive into today's docs.
		perl -pi -e "s{base: \"/docs\",}{base: \"/docs/$slug\",}" astro.config.mjs
		grep -q "base: \"/docs/$slug\"," astro.config.mjs \
			|| { echo "build-archives: could not rebase $tag's astro config" >&2; exit 1; }
		find src/content/docs \( -name '*.md' -o -name '*.mdx' \) \
			-exec perl -pi -e "s{\\]\\(/docs/}{](/docs/$slug/}g" {} +

		bun install --frozen-lockfile >/dev/null
		AGENTKIT_DOCS_VERSION="$tag" node ./node_modules/astro/bin/astro.mjs build \
			|| { echo "build-archives: the $tag docs no longer build" >&2; exit 1; }

		rm -rf "${DIST_ABS:?}/$slug"
		cp -R dist "$DIST_ABS/$slug"
	) || die "archive $slug ($tag) failed"

	# The link rewrite covers the markdown form; anything that still points at
	# bare /docs/ escaped the archive and must not publish.
	# `|| true`: zero escapes is the good case, and grep's no-match status must
	# not read as a failure under pipefail. Slug dots are escaped so `0.4`
	# cannot accidentally bless an `0X4` path as in-mount.
	slug_re=${slug//./\\.}
	escapes=$(grep -rhoE '(href|src)="/docs/[^"]*"' "$DIST_ABS/$slug" 2>/dev/null \
		| grep -vE "(href|src)=\"/docs/$slug_re/" | sort -u | head -3 || true)
	[[ -z "$escapes" ]] || die "archive $slug links escape its mount: $escapes"
	echo "[archive] $slug: $(find "$DIST_ABS/$slug" -type f | wc -l | tr -d ' ') files"
done < "$ENTRIES"
