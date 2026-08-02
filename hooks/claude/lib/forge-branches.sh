# shellcheck shell=bash
# Whether a branch is finished is answered by the forge, never by git topology.
# A squash merge puts the squashed commit outside the branch's ancestry and
# leaves the merge base before it forever: measured on nine branches of known
# outcome, ancestry counts, two- and three-dot diffs and an in-memory
# merge-tree comparison each reported all seven merged ones as outstanding,
# and agreed with each other while doing it.

AGENTKIT_FORGE_KIND=""
AGENTKIT_FORGE_HOST=""

# Non-zero means no forge could be reached: no origin, no CLI, or an
# unauthenticated one. Callers must not read that as an empty backlog.
agentkit_detect_forge() {
	local repo="$1" url host
	AGENTKIT_FORGE_KIND=""
	AGENTKIT_FORGE_HOST=""
	url=$(git -C "$repo" remote get-url origin 2>/dev/null || true)
	[[ -n "$url" ]] || return 1
	host=$(printf '%s' "$url" | sed -E 's#^(git\+)?(ssh://)?(git@|https?://)?([^:/]+).*#\4#')
	[[ -n "$host" ]] || return 1

	if command -v gh >/dev/null 2>&1 \
		&& { [[ "$host" == "github.com" ]] || gh auth status --hostname "$host" >/dev/null 2>&1; }; then
		AGENTKIT_FORGE_KIND="github"
		AGENTKIT_FORGE_HOST="$host"
		return 0
	fi
	if command -v glab >/dev/null 2>&1 \
		&& (cd "$repo" && GITLAB_HOST="$host" glab api /version >/dev/null 2>&1); then
		AGENTKIT_FORGE_KIND="gitlab"
		AGENTKIT_FORGE_HOST="$host"
		return 0
	fi
	return 1
}

# BRANCH<TAB>STATE for every change the forge knows of, normalised to
# merged / opened / closed. The JSON is validated before rows are extracted, so
# a failed call cannot arrive as the same empty output that a repository with
# no changes at all produces — which is the case worth catching. The listing is
# windowed by the forge's own cap; callers reach this after `fetch -p`, where a
# long-merged branch that fell out of the window shows a gone upstream instead.
agentkit_forge_branch_states() {
	local repo="$1" raw
	case "$AGENTKIT_FORGE_KIND" in
	github)
		raw=$( (cd "$repo" && GH_HOST="$AGENTKIT_FORGE_HOST" \
			gh pr list --state all --limit 200 --json headRefName,state) 2>/dev/null) || return 1
		printf '%s' "$raw" | _agentkit_jq -e 'type == "array"' >/dev/null 2>&1 || return 1
		printf '%s' "$raw" | _agentkit_jq -r '.[] | [.headRefName, (.state | ascii_downcase)] | @tsv'
		;;
	gitlab)
		raw=$( (cd "$repo" && GITLAB_HOST="$AGENTKIT_FORGE_HOST" \
			glab api "projects/:fullpath/merge_requests?state=all&per_page=100&order_by=updated_at") 2>/dev/null) || return 1
		printf '%s' "$raw" | _agentkit_jq -e 'type == "array"' >/dev/null 2>&1 || return 1
		printf '%s' "$raw" | _agentkit_jq -r '.[] | [.source_branch, .state] | @tsv'
		;;
	*) return 1 ;;
	esac
	return 0
}

# One branch's state from those rows. Merged wins: one merged change means the
# work landed, whatever was closed alongside it. Empty means the forge has
# never seen a change from this branch.
agentkit_branch_state() {
	local branch="$1" rows name state open_state="" closed_state=""
	rows=$(printf '%s\n' "$2" | grep -F "$branch	" || true)
	[[ -n "$rows" ]] || return 0
	while IFS=$'\t' read -r name state; do
		[[ "$name" == "$branch" ]] || continue
		case "$state" in
		merged)
			printf 'merged'
			return 0
			;;
		open | opened | locked) open_state="opened" ;;
		closed) closed_state="closed" ;;
		esac
	done <<<"$rows"
	printf '%s' "${open_state:-$closed_state}"
	return 0
}
