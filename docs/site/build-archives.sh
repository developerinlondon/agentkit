#!/usr/bin/env bash
# Builds each archived docs version from its git tag into <dist>/<slug>/, with
# that tag's own content, dependencies and toolchain. Archives used to be page
# copies committed on main, which let current-code renames break or silently
# falsify a released version; a tag build cannot be reached by main at all.
set -euo pipefail
cd "$(dirname "$0")"

DIST="${1:-dist}"
MANIFEST=archived-versions.json
REPO_ROOT=$(git rev-parse --show-toplevel)

die() {
	echo "build-archives: $*" >&2
	exit 1
}

command -v jq >/dev/null || die "jq is required to read $MANIFEST"
[[ -f "$MANIFEST" ]] || die "missing $MANIFEST"
[[ -d "$DIST" ]] || die "no $DIST — build the current docs first"
DIST_ABS=$(cd "$DIST" && pwd)

count=$(jq 'length' "$MANIFEST")
for i in $(seq 0 $((count - 1))); do
	slug=$(jq -r ".[$i].slug" "$MANIFEST")
	tag=$(jq -r ".[$i].tag" "$MANIFEST")
	[[ "$slug" =~ ^[0-9][0-9.]*$ && "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
		|| die "manifest entry $i is malformed: slug='$slug' tag='$tag'"
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
		find src/content/docs -name '*.md' -o -name '*.mdx' \
			| xargs -r perl -pi -e "s{\\]\\(/docs/}{](/docs/$slug/}g"

		bun install --frozen-lockfile >/dev/null
		AGENTKIT_DOCS_VERSION="$tag" node ./node_modules/astro/bin/astro.mjs build \
			|| { echo "build-archives: the $tag docs no longer build" >&2; exit 1; }

		rm -rf "${DIST_ABS:?}/$slug"
		cp -R dist "$DIST_ABS/$slug"
	) || die "archive $slug ($tag) failed"
	echo "[archive] $slug: $(find "$DIST_ABS/$slug" -type f | wc -l | tr -d ' ') files"
done
