#!/usr/bin/env bash
set -euo pipefail

# One-line installer: curl -fsSL …/bootstrap.sh | bash [-s -- --with product]
# Piped stdin is not a tty, so the optional-group question never fires here —
# pass --with <group> explicitly.
# Everything runs from main so a truncated download is a syntax error, never a
# partial install.
main() {
	local repo_url="${AGENTKIT_REPO_URL:-https://github.com/developerinlondon/agentkit.git}"
	local src_dir="${AGENTKIT_SRC:-$HOME/.agentkit-src}"

	command -v git >/dev/null || die "git is required"

	if [[ -d "$src_dir/.git" ]]; then
		[[ -z "$(git -C "$src_dir" status --porcelain -uno)" ]] \
			|| die "$src_dir has local changes — stash or move them aside, or point AGENTKIT_SRC at a clean dir"
		echo "[bootstrap] Updating $src_dir"
		git -C "$src_dir" fetch --depth 1 origin || die "fetch failed — check network and $src_dir"
		git -C "$src_dir" reset --hard origin/HEAD >/dev/null \
			|| die "update failed — origin/HEAD is unresolvable in $src_dir; re-clone or fix the remote"
	elif [[ -e "$src_dir" ]]; then
		die "$src_dir exists but is not a git clone — move it aside or set AGENTKIT_SRC"
	else
		echo "[bootstrap] Cloning agentkit into $src_dir"
		git clone --depth 1 "$repo_url" "$src_dir" || die "clone failed"
	fi

	exec bash "$src_dir/install.sh" --global "$@"
}

die() { echo "bootstrap: $*" >&2; exit 1; }

main "$@"
