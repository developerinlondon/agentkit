#!/usr/bin/env bash
set -euo pipefail

# One-line installer: curl -fsSL …/bootstrap.sh | bash
# Clones (or updates) the kit into a persistent source dir, then hands off to
# install.sh --global. Arguments pass through: … | bash -s -- --with product

REPO_URL="${AGENTKIT_REPO_URL:-https://github.com/developerinlondon/agentkit.git}"
SRC_DIR="${AGENTKIT_SRC:-$HOME/.agentkit-src}"

die() { echo "bootstrap: $*" >&2; exit 1; }

command -v git >/dev/null || die "git is required"
command -v bash >/dev/null || die "bash is required"

if [[ -d "$SRC_DIR/.git" ]]; then
	echo "[bootstrap] Updating $SRC_DIR"
	git -C "$SRC_DIR" fetch --depth 1 origin || die "fetch failed — check network and $SRC_DIR"
	git -C "$SRC_DIR" reset --hard origin/HEAD >/dev/null
elif [[ -e "$SRC_DIR" ]]; then
	die "$SRC_DIR exists but is not a git clone — move it aside or set AGENTKIT_SRC"
else
	echo "[bootstrap] Cloning agentkit into $SRC_DIR"
	git clone --depth 1 "$REPO_URL" "$SRC_DIR" || die "clone failed"
fi

exec bash "$SRC_DIR/install.sh" --global "$@"
