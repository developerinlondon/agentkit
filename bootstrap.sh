#!/usr/bin/env bash
set -euo pipefail

# One-line installer: curl -fsSL …/bootstrap.sh | bash [-s -- --with product]
# Piped stdin is not a tty, so the optional-kit question never fires here —
# pass --with <kit> explicitly.
# Installs the newest release tag. AGENTKIT_REF takes a tag or a branch instead;
# AGENTKIT_REF=main is the bleeding edge.
main() {
	local repo_url="${AGENTKIT_REPO_URL:-https://github.com/developerinlondon/agentkit.git}"
	local src_dir="${AGENTKIT_SRC:-$HOME/.agentkit-src}"
	local ref="${AGENTKIT_REF:-}"

	command -v git >/dev/null || die "git is required"

	# A silent fall back to the default branch is how "installs are tagged" stops
	# being true without anyone noticing, so an absent tag is fatal instead.
	if [[ -z "$ref" ]]; then
		ref=$(latest_tag "$repo_url") \
			|| die "no v<major>.<minor>.<patch> tag at $repo_url — set AGENTKIT_REF to a tag or branch"
		echo "[bootstrap] Latest release: $ref"
	else
		echo "[bootstrap] Requested ref: $ref"
	fi

	if [[ -d "$src_dir/.git" ]]; then
		[[ -z "$(git -C "$src_dir" status --porcelain -uno)" ]] \
			|| die "$src_dir has local changes — stash or move them aside, or point AGENTKIT_SRC at a clean dir"
		echo "[bootstrap] Updating $src_dir to $ref"
		git -C "$src_dir" fetch --depth 1 origin "$ref" \
			|| die "fetch of '$ref' failed — check network, and that '$ref' exists at $repo_url"
		git -C "$src_dir" reset --hard FETCH_HEAD >/dev/null \
			|| die "checkout of '$ref' failed in $src_dir — re-clone or fix the remote"
	elif [[ -e "$src_dir" ]]; then
		die "$src_dir exists but is not a git clone — move it aside or set AGENTKIT_SRC"
	else
		echo "[bootstrap] Cloning agentkit into $src_dir at $ref"
		git clone --depth 1 --branch "$ref" "$repo_url" "$src_dir" \
			|| die "clone of '$ref' failed — check network, and that '$ref' is a tag or branch at $repo_url"
	fi

	echo "[bootstrap] Installing from $ref"
	exec bash "$src_dir/install.sh" --global "$@"
}

# Newest v<major>.<minor>.<patch> tag on the remote, read without cloning.
# hooks/claude/lib/latest-tag.sh is the sourceable twin — this copy exists
# because a curl-piped single file has nothing to source; keep them in step.
# Sorted field by field as numbers: `sort -V` is GNU-only and missing on macOS,
# and a lexical sort ranks v0.4.9 above v0.4.10.
latest_tag() {
	local url="$1" newest
	newest=$(git ls-remote --tags --refs "$url" 2>/dev/null \
		| awk '{ sub(/^refs\/tags\//, "", $2); print $2 }' \
		| grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
		| sed 's/^v//' \
		| sort -t. -k1,1n -k2,2n -k3,3n \
		| tail -1)
	[[ -n "$newest" ]] || return 1
	printf 'v%s\n' "$newest"
}

die() {
	echo "bootstrap: $*" >&2
	exit 1
}

main "$@"
