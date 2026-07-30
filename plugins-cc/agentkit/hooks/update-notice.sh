#!/usr/bin/env bash
# SessionStart: one line when a newer AgentKit release exists. Never blocks and
# never installs anything — every failure path here is silence, because a
# version check must not cost a session anything.

AGENTKIT_HOME="${AGENTKIT_HOME:-$HOME/.agentkit}"
STAMP="$AGENTKIT_HOME/version"
CACHE="$AGENTKIT_HOME/.update-check"
REPO_URL="${AGENTKIT_UPDATE_REMOTE:-https://github.com/developerinlondon/agentkit.git}"
TTL=86400
FAILURE_TTL=3600

lib="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/lib/latest-tag.sh"
[ -r "$lib" ] || exit 0
. "$lib"

[ -r "$STAMP" ] || exit 0
installed=$(head -n1 "$STAMP" 2>/dev/null)
case "$installed" in v[0-9]*) ;; *) exit 0 ;; esac

now=$(date +%s 2>/dev/null) || exit 0
latest=""
if [ -r "$CACHE" ]; then
	read -r cached_at cached_tag _ <"$CACHE" 2>/dev/null || true
	if [ "${cached_at:-}" -gt 0 ] 2>/dev/null; then
		age=$((now - cached_at))
		ttl="$TTL"
		# A '-' records a recent failed check, so a broken network is retried
		# on its own clock instead of at every single session start.
		[ "$cached_tag" = "-" ] && ttl="$FAILURE_TTL"
		if [ "$age" -ge 0 ] && [ "$age" -lt "$ttl" ]; then
			case "$cached_tag" in
			-) exit 0 ;;
			v[0-9]*.[0-9]*) latest="$cached_tag" ;;
			esac
		fi
	fi
fi

if [ -z "$latest" ]; then
	if ! latest=$(latest_remote_tag "$REPO_URL"); then
		printf '%s -\n' "$now" 2>/dev/null >"$CACHE" || true
		exit 0
	fi
	printf '%s %s\n' "$now" "$latest" 2>/dev/null >"$CACHE" || true
fi

case "$latest" in v[0-9]*) ;; *) exit 0 ;; esac
[ "$latest" = "$installed" ] && exit 0

newer=$(printf '%s\n%s\n' "${installed#v}" "${latest#v}" \
	| sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
[ "v$newer" = "$latest" ] || exit 0

echo "[agentkit] $installed installed — $latest is available: re-run install.sh --global from an updated clone (or the curl bootstrap)."
exit 0
