#!/usr/bin/env bash
# SessionStart: one line when a newer AgentKit release exists. Never blocks and
# never installs anything — every failure path here is silence, because a
# version check must not cost a session anything.

AGENTKIT_HOME="${AGENTKIT_HOME:-$HOME/.agentkit}"
STAMP="$AGENTKIT_HOME/version"
CACHE="$AGENTKIT_HOME/.update-check"
REPO_URL="${AGENTKIT_UPDATE_REMOTE:-https://github.com/developerinlondon/agentkit.git}"
TTL=86400

[ -r "$STAMP" ] || exit 0
installed=$(head -n1 "$STAMP" 2>/dev/null)
case "$installed" in v[0-9]*) ;; *) exit 0 ;; esac

now=$(date +%s 2>/dev/null) || exit 0
latest=""
if [ -r "$CACHE" ]; then
	read -r cached_at cached_tag <"$CACHE" 2>/dev/null || true
	if [ "$cached_at" -gt 0 ] 2>/dev/null && [ $((now - cached_at)) -lt "$TTL" ]; then
		latest="$cached_tag"
	fi
fi

if [ -z "$latest" ]; then
	# Newest vX.Y.Z on the remote, numerically: sort -V is GNU-only, and a
	# lexical sort ranks v0.4.9 above v0.4.10.
	latest=$(timeout 4 git ls-remote --tags --refs "$REPO_URL" 2>/dev/null \
		| awk '{ sub(/^refs\/tags\//, "", $2); print $2 }' \
		| grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
		| sed 's/^v//' \
		| sort -t. -k1,1n -k2,2n -k3,3n \
		| tail -1)
	[ -n "$latest" ] || exit 0
	latest="v$latest"
	printf '%s %s\n' "$now" "$latest" >"$CACHE" 2>/dev/null || true
fi

case "$latest" in v[0-9]*) ;; *) exit 0 ;; esac
[ "$latest" = "$installed" ] && exit 0

newer=$(printf '%s\n%s\n' "${installed#v}" "${latest#v}" \
	| sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
[ "v$newer" = "$latest" ] || exit 0

echo "[agentkit] $installed installed — $latest is available: re-run install.sh --global from an updated clone (or the curl bootstrap)."
exit 0
