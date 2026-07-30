# Newest vX.Y.Z tag on a remote, numerically: sort -V is GNU-only and a lexical
# sort ranks v0.4.9 above v0.4.10. bootstrap.sh carries its own copy because it
# runs as a curl-piped single file with nothing to source — keep them in step.
# `timeout` is also GNU-only: Homebrew ships it as gtimeout, stock macOS has
# neither, and without a bound the caller's own hook timeout is the ceiling.
latest_remote_tag() {
	local url="$1" bound="" newest
	if command -v timeout >/dev/null 2>&1; then
		bound="timeout 4"
	elif command -v gtimeout >/dev/null 2>&1; then
		bound="gtimeout 4"
	fi
	newest=$(GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true $bound git ls-remote --tags --refs "$url" 2>/dev/null \
		| awk '{ sub(/^refs\/tags\//, "", $2); print $2 }' \
		| grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
		| sed 's/^v//' \
		| sort -t. -k1,1n -k2,2n -k3,3n \
		| tail -1)
	[ -n "$newest" ] || return 1
	printf 'v%s\n' "$newest"
}
