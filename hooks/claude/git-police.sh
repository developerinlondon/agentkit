#!/usr/bin/env bash
# git-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: force push, --no-verify, AI attribution (commit trailers AND MR/PR/issue
# content), commits to protected branches, stale branch creation
# OpenCode counterpart: plugins/git-police.ts (the text rules match; the
# target-repository and crash handling below exist only here)
set -euo pipefail

# bash 3.2 cannot parse `(` inside [[ =~ ]], and this is a PreToolUse Bash
# hook: a parse error denies EVERY command, with no way to switch it off.
RE_YAML_ITEM='^[[:space:]]*-[[:space:]]+(.*)'

PROTECTED_BRANCHES=("main" "master")
AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"

# A hook that dies decides nothing, and the harness reads a non-zero exit other
# than 2 as a non-blocking error: the command runs unjudged. So a crash refuses
# the commands this hook exists to judge, and says UNCHECKED for anything else.
# Installed before the payload is read, and written without jq, because jq
# failing is one of the ways this hook dies. If the command was never read
# there is nothing to judge, so that case reports rather than refuses: a
# machine without jq must not lose the ability to commit.
on_unexpected_exit() {
	local code=$?
	[[ $code -eq 0 ]] && return 0
	trap - EXIT
	local judged="${STRIPPED:-${COMMAND:-}}"
	if [[ -n "$judged" ]] && echo "$judged" | grep -qiE '\bgit\b.*\b(commit|push)\b|\bglab[[:space:]]+(mr|issue)\b|\bgh[[:space:]]+(pr|issue|release)\b|\b(glab|gh)[[:space:]]+api\b'; then
		local reason="BLOCKED: git-police failed (exit $code) before it could judge this command, and a guard that crashed has approved nothing. Re-run the hook under bash -x to see where it died."
		printf '{"decision":"deny","reason":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason" "$reason"
	else
		local msg="UNCHECKED: git-police failed (exit $code) before it could judge this command."
		printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$msg" "$msg"
	fi
	exit 0
}
trap on_unexpected_exit EXIT

# Every rule below is a grep over text. Without grep each one evaluates false
# and the hook would exit 0 having judged nothing, which no trap can see.
command -v grep >/dev/null 2>&1 && command -v sed >/dev/null 2>&1 || exit 127

# shellcheck source=lib/hook-input.sh
# Pure bash dirname: external `dirname` is missing when PATH is empty (the
# missing-jq fail-open probe), and a source failure under set -e would silence
# the gate. BASH_SOURCE is absolute when the harness invokes the script by path.
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)

[[ -z "$COMMAND" ]] && exit 0

load_allowed_repos() {
	# `return` alone propagates the failed test's status 1, and this runs as a
	# plain command under `set -e`: with no config file the hook exited 1 with
	# NO decision — every guard below it off — which the harness reads as ALLOW.
	[[ -f "$AGENTKIT_CONFIG" ]] || return 0
	local in_section=false
	while IFS= read -r line; do
		if [[ "$line" =~ ^[[:space:]]*branch-protection: ]]; then
			in_section=true
			continue
		fi
		if [[ "$in_section" == true && "$line" =~ ^[[:space:]]*allowed-repos: ]]; then
			continue
		fi
		if [[ "$in_section" == true && "$line" =~ $RE_YAML_ITEM ]]; then
			ALLOWED_REPOS+=("${BASH_REMATCH[1]}")
		elif [[ "$in_section" == true && ! "$line" =~ ^[[:space:]] ]]; then
			break
		fi
	done < <(sed -n '/^git-police:/,/^[^ ]/p' "$AGENTKIT_CONFIG")
}

ALLOWED_REPOS=()
load_allowed_repos

STRIPPED=$(echo "$COMMAND" |
	sed -E "s/<<-?[[:space:]]*['\"]?([A-Za-z_]+)['\"]?/\n\1_HEREDOC_START\n/g" |
	sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g" |
	sed -E "s/'[^']*'/''/g")

# The repo a git command operates on: honor `git -C <path>` and a `cd <path>`
# at the start or after a separator (; && |), falling back to the hook's cwd.
# The session cwd may be a different repo entirely (or none at all) — every
# repo-state check below must resolve against the targeted repo, not the cwd.
# Quoted paths were emptied out of STRIPPED, so those fall back to the cwd.
git_target_dir() {
	local dir
	dir=$(echo "$1" | sed -nE 's/.*git[[:space:]]+-C[[:space:]]+([^[:space:]]+).*/\1/p' | head -1)
	if [[ -z "$dir" ]]; then
		dir=$(echo "$1" | sed -nE 's/(^|.*[;&|])[[:space:]]*cd[[:space:]]+([^[:space:];&|]+).*/\2/p' | head -1)
	fi
	echo "$dir"
}
NAMED_DIR=$(git_target_dir "$STRIPPED")
TARGET_DIR="${NAMED_DIR/#\~/$HOME}"

# `cd $W` and `git -C "$DIR"` reach here unexpanded or emptied. A path that is
# not a directory would make every tgit call exit 128, so the hook's cwd is
# judged instead, and every refusal built on that guess says so.
TARGET_NOTE=""
if [[ -n "$TARGET_DIR" && ! -d "$TARGET_DIR" ]]; then
	TARGET_NOTE=" NOTE: git-police could not resolve the directory this command names (${NAMED_DIR}), so it judged the hook's working directory instead. If that is a different repository, name the real one with a literal path: git -C /absolute/path ..."
	TARGET_DIR=""
fi

# git scoped to the targeted repo (cwd when the command names none).
tgit() {
	git ${TARGET_DIR:+-C "$TARGET_DIR"} "$@"
}

deny() {
	local reason="$1"
	agentkit_deny_json "$reason"
	exit 0
}

# advise: surface a reminder to the agent WITHOUT blocking the command. No
# permissionDecision is emitted, so the normal permission flow runs and the
# tool proceeds; `additionalContext` is the only PreToolUse channel Claude
# Code injects into the model as a system reminder (permissionDecisionReason
# reaches Claude only on "deny", and stdout on exit 0 is discarded).
advise() {
	local msg="$1"
	agentkit_advise_json "$msg"
	exit 0
}

# Detect `git commit` as a subcommand (not the literal substring "commit"
# inside a config key like `git config commit.gpgsign`).
GIT_COMMIT_RE='\bgit([[:space:]]+(-[A-Za-z][^[:space:]]*|--[A-Za-z][A-Za-z0-9-]*(=[^[:space:]]+)?)([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit\b'

# An annotated tag and a note carry a message the same way a commit does.
GIT_ANNOTATE_RE='\bgit\b[^;&|]*[[:space:]](tag|notes)[[:space:]]'

# Commands that publish authored content to the forge — MR/PR/issue bodies,
# comments, release notes, and raw API calls that write (a method or a field). Same no-AI-attribution rule as commit messages:
# everything published under the user's name is theirs, not the agent's.
FORGE_WRITE_RE='\bglab[[:space:]]+(mr|issue)[[:space:]]+(create|update|edit|note|comment)\b|\bgh[[:space:]]+(pr|issue|release)[[:space:]]+(create|edit|comment|merge|review)\b|\b(glab|gh)[[:space:]]+api\b.*[[:space:]](-X|--method)[[:space:]=]*(POST|PUT|PATCH)\b|\b(glab|gh)[[:space:]]+api\b.*[[:space:]](-f|-F|--field|--raw-field|--input)\b'

# A trailer is the name followed by `:` (or `=`, the --trailer form). Requiring
# the separator lets a message that merely talks about the trailer through.
ATTRIBUTION_RE='co-authored-by[[:space:]]*[:=]|generated with \[claude code\]|🤖 generated|claude\.ai/code|claude\.com/claude-code|noreply@anthropic\.com'

# Every file a commit, tag, note or gh write takes its message from: -F<path>, -F <path>, bundled as
# -qF, --file <path>, --file=<path>, quoted or not, one per line. Read from the
# first such command to the end of the command, so a `grep -F` before it is not
# mistaken for one. `-` is stdin, whose heredoc is already in the payload.
RE_COMMIT_TAIL='(git[^;&|]*[[:space:]](commit|tag|notes)|gh[[:space:]]+(pr|issue|release))([[:space:]].*)'
commit_message_args() {
	[[ "$COMMAND" =~ $RE_COMMIT_TAIL ]] || return 0
	echo "${BASH_REMATCH[4]}" |
		{ grep -oE -- "[[:space:]](-[aqsvneziop]*F|--file|--body-file|--notes-file)([[:space:]]*=[[:space:]]*|[[:space:]]*)(\"[^\"]*\"|'[^']*'|[^[:space:];&|]+)" || true; } |
		sed -E "s/^[[:space:]]*(-[aqsvneziop]*F|--file|--body-file|--notes-file)[[:space:]]*=?[[:space:]]*//; s/^[\"'](.*)[\"']\$/\1/"
}

# 0. Block AI attribution trailers / signatures in commit commands AND in
#    forge-content commands. Pure text, so it runs ahead of the allow-list and
#    of every rule that needs repository state: neither an exempt repository
#    nor a target the hook cannot resolve may skip it.
#    The payload is what agentkit_slurp_input read from stdin. Naming any
#    other variable here trips `set -u` in the pipeline's subshell only: the
#    echo dies, grep reads nothing, the test is false, and this one rule never
#    fires while every other rule carries on — which is how it shipped twice.
if echo "$STRIPPED" | grep -qiE "$GIT_COMMIT_RE" || echo "$STRIPPED" | grep -qiE "$GIT_ANNOTATE_RE" || echo "$STRIPPED" | grep -qiE "$FORGE_WRITE_RE"; then
	ATTRIBUTED=false
	echo "${AGENTKIT_RAW_INPUT:-}" | grep -qiE "$ATTRIBUTION_RE" && ATTRIBUTED=true
	while IFS= read -r MESSAGE_FILE; do
		[[ -z "$MESSAGE_FILE" || "$MESSAGE_FILE" == "-" ]] && continue
		# The shell expands these after this hook has run; the message they
		# name cannot be read from here, and an unread message is not a clean one.
		case "$MESSAGE_FILE" in
		*'$'* | *'`'*)
			deny "BLOCKED: git-police cannot read the message file named by '${MESSAGE_FILE}': the shell expands it after this hook runs. Pass the literal path (-F /path/to/message) so the message can be checked for AI attribution."
			;;
		esac
		MESSAGE_FILE="${MESSAGE_FILE/#\~/$HOME}"
		[[ "$MESSAGE_FILE" != /* && -n "$TARGET_DIR" ]] && MESSAGE_FILE="$TARGET_DIR/$MESSAGE_FILE"
		# A file that does not exist yet is written by this same command, so
		# its text is in the payload already.
		if [[ -f "$MESSAGE_FILE" && -r "$MESSAGE_FILE" ]] && grep -qiE "$ATTRIBUTION_RE" "$MESSAGE_FILE"; then
			ATTRIBUTED=true
		fi
	done < <(commit_message_args)
	if [[ "$ATTRIBUTED" == true ]]; then
		deny "BLOCKED: AI attribution is forbidden — in commit messages and in MR/PR/issue descriptions or comments alike. Do not add Co-authored-by, Signed-off-by, '🤖 Generated with [Claude Code]', claude.ai/code or claude.com/claude-code links, noreply@anthropic.com co-authors, or any other AI agent attribution. The author is whoever owns the git config. Remove the attribution and retry."
	fi
fi

# 1. Block --no-verify (skips pre-commit/commit-msg hooks)
if echo "$STRIPPED" | grep -qiE '\bgit\b.*--no-verify\b'; then
	deny "BLOCKED: --no-verify is forbidden. Skipping pre-commit hooks bypasses quality gates (linting, tests, formatting). Fix the issue that's causing the hook to fail instead."
fi

# Detect `git push` as a subcommand (allowing global flags like -C <path>), so
# `git stash push`, or "push" appearing in a branch name or message, never
# matches the push rules. Same shape as GIT_COMMIT_RE below.
GIT_PUSH_RE='\bgit([[:space:]]+(-[A-Za-z][^[:space:]]*|--[A-Za-z][A-Za-z0-9-]*(=[^[:space:]]+)?)([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+push\b'

# 2. Block force push (--force, -f, --force-with-lease). Every variant rewrites
#    remote history; sanctioned rewrites are pushed by the user directly.
if echo "$STRIPPED" | grep -qiE "${GIT_PUSH_RE}"'.*(-f\b|--force\b|--force-with-lease\b)'; then
	deny "BLOCKED: Force push is forbidden. Force pushing rewrites history and can destroy work. If a history rewrite is truly required, prepare the branch and ask the user to run the force push themselves."
fi

# allowed-repos lifts branch protection only: direct commits and pushes to
# main/master. Attribution, --no-verify and force push are judged above it,
# and a repository the hook could not resolve is never taken for an allowed one.
if [[ ${#ALLOWED_REPOS[@]} -gt 0 && -z "$TARGET_NOTE" ]]; then
	REPO_URL=$(tgit remote get-url origin 2>/dev/null || echo "")
	REPO_NAME=$(echo "${REPO_URL%.git}" | sed -E 's|.*[:/]([^/]+/[^/]+)$|\1|')
	for allowed in "${ALLOWED_REPOS[@]+"${ALLOWED_REPOS[@]}"}"; do
		if [[ "$REPO_NAME" == *"$allowed"* ]]; then
			exit 0
		fi
	done
fi

# The remote a push targets: the first non-flag token after `push` (empty for
# the implicit upstream). Branch protection guards the canonical repo (origin);
# pushes that explicitly name a different remote are mirror syncs of refs that
# already went through review there, so rules 3 and 4 let them pass.
push_remote() {
	echo "$1" | awk '{
		for (i = 1; i <= NF; i++)
			if ($i == "push") {
				for (j = i + 1; j <= NF; j++)
					if ($j !~ /^-/) { print $j; exit }
				exit
			}
	}'
}
PUSH_REMOTE=$(push_remote "$STRIPPED")

# 3. Block pushing directly to protected branches (on origin / implicit upstream)
if [[ -z "$PUSH_REMOTE" || "$PUSH_REMOTE" == "origin" ]]; then
	for branch in "${PROTECTED_BRANCHES[@]+"${PROTECTED_BRANCHES[@]}"}"; do
		if echo "$STRIPPED" | grep -qiE "${GIT_PUSH_RE}.*\b${branch}\b"; then
			deny "BLOCKED: Pushing directly to '${branch}' is forbidden. Create a feature branch and raise a PR instead."
		fi
	done
fi

# 4. Block push when the targeted repo is on a protected branch (even without

# 5. Block creating a branch in a clone that other worktrees share. Another
#    agent may be working in it, and checkout swaps the tree under them.
SHARED_BRANCH_OK="${AGENTKIT_ALLOW_SHARED_BRANCH:-}"
# Also honoured inline, since a prefix never reaches this hook's environment.
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])AGENTKIT_ALLOW_SHARED_BRANCH=1'; then
	SHARED_BRANCH_OK=1
fi
if [[ "$SHARED_BRANCH_OK" != "1" ]] \
	&& echo "$STRIPPED" | grep -qiE '\bgit([[:space:]]+-[A-Za-z][^[:space:]]*([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+(checkout[[:space:]]+(-b|-B)|switch[[:space:]]+(-c|-C))\b'; then
	GIT_DIR_PATH=$(tgit rev-parse --git-dir 2>/dev/null || echo "")
	COMMON_DIR_PATH=$(tgit rev-parse --git-common-dir 2>/dev/null || echo "")
	# Equal ⇒ this IS the main clone; differing ⇒ already inside a worktree.
	if [[ -n "$GIT_DIR_PATH" && "$GIT_DIR_PATH" == "$COMMON_DIR_PATH" ]]; then
		WORKTREE_COUNT=$(tgit worktree list 2>/dev/null | wc -l | tr -d ' ' || echo 0)
		if [[ "${WORKTREE_COUNT:-0}" -gt 1 ]]; then
			REPO_BASE=$(basename "$(tgit rev-parse --show-toplevel 2>/dev/null || echo repo)")
			deny "BLOCKED: creating a branch in a shared clone. This checkout has ${WORKTREE_COUNT} worktrees, so another agent may be working in it and a checkout swaps the tree under them. Create a worktree instead:

  git worktree add ../${REPO_BASE}-wt/<name> -b <branch> origin/<default>

Intentional (nobody else is in this clone): prefix with AGENTKIT_ALLOW_SHARED_BRANCH=1.${TARGET_NOTE}"
		fi
	fi
fi
#    branch name in command) — same origin scoping as rule 3.
if [[ -z "$PUSH_REMOTE" || "$PUSH_REMOTE" == "origin" ]] \
	&& echo "$STRIPPED" | grep -qiE "$GIT_PUSH_RE"; then
	CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
	for branch in "${PROTECTED_BRANCHES[@]+"${PROTECTED_BRANCHES[@]}"}"; do
		if [[ "$CURRENT_BRANCH" == "$branch" ]]; then
			deny "BLOCKED: You are on '${branch}'. Pushing from a protected branch is forbidden. Create a feature branch first: git checkout -b feat/your-feature-name${TARGET_NOTE}"
		fi
	done
fi

# 4b. Freshness: a feature-branch push must carry the latest integration
#     branch — a stale branch merges into a codebase it never saw (squash-merge
#     repos surface this as surprise conflicts or silently regressed files).
#     The fetch is a single ref and quick. The integration branch defaults to
#     origin/HEAD; repos whose MRs target another branch (env-branch layouts)
#     set it once with: git config agentkit.integration-branch <branch>.
#     The override works from the hook's environment or inline in the command
#     itself (`AGENTKIT_ALLOW_STALE_PUSH=1 git push …`) — inline assignments
#     never reach the hook process, so honor them from the text (same
#     treatment as AGENTKIT_ALLOW_BRANCH_STACKING in rule 7).
STALE_PUSH_OK="${AGENTKIT_ALLOW_STALE_PUSH:-0}"
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])AGENTKIT_ALLOW_STALE_PUSH=1([[:space:];&|]|$)'; then
	STALE_PUSH_OK=1
fi
if [[ -z "$PUSH_REMOTE" || "$PUSH_REMOTE" == "origin" ]] \
	&& [[ "$STALE_PUSH_OK" != "1" ]] \
	&& echo "$STRIPPED" | grep -qiE "$GIT_PUSH_RE"; then
	INTEGRATION_BRANCH=$(tgit config --get agentkit.integration-branch 2>/dev/null || true)
	DEFAULT_BRANCH="$INTEGRATION_BRANCH"
	if [[ -z "$DEFAULT_BRANCH" ]]; then
		DEFAULT_BRANCH=$(tgit symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
	fi
	if [[ -z "$DEFAULT_BRANCH" ]]; then
		for cand in main master; do
			if tgit show-ref --verify --quiet "refs/remotes/origin/${cand}" 2>/dev/null; then
				DEFAULT_BRANCH="$cand"
				break
			fi
		done
	fi
	if [[ -n "$DEFAULT_BRANCH" ]]; then
		tgit fetch --quiet origin "$DEFAULT_BRANCH" 2>/dev/null || true
		BEHIND=$(tgit rev-list --count "HEAD..origin/${DEFAULT_BRANCH}" 2>/dev/null || echo 0)
		if [[ "${BEHIND:-0}" -gt 0 ]]; then
			deny "BLOCKED: Your branch is ${BEHIND} commit(s) behind origin/${DEFAULT_BRANCH}. Merge the latest ${DEFAULT_BRANCH} before pushing: git fetch origin && git merge origin/${DEFAULT_BRANCH} — resolve any conflicts, re-run the repo's gates, then push. Intentional stale push: prefix the command with AGENTKIT_ALLOW_STALE_PUSH=1. MRs targeting a different branch: git config agentkit.integration-branch <branch>.${TARGET_NOTE}"
		fi
	fi
fi

# 6. Block direct commits to protected branches
if echo "$STRIPPED" | grep -qiE "$GIT_COMMIT_RE"; then
	CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
	for branch in "${PROTECTED_BRANCHES[@]+"${PROTECTED_BRANCHES[@]}"}"; do
		if [[ "$CURRENT_BRANCH" == "$branch" ]]; then
			deny "BLOCKED: Committing directly to '${branch}' is forbidden. You are on the ${branch} branch. Create a feature branch first: git checkout -b feat/your-feature-name${TARGET_NOTE}"
		fi
	done
fi

# 7. Branch hygiene at branch creation — the only reliable local chokepoint
#    (merges happen server-side, so there is no "after merge" hook event).
#    a) new branches are cut from the default branch, not stacked on another
#       feature branch (squash merges make stacks conflict); override with
#       AGENTKIT_ALLOW_BRANCH_STACKING=1 for intentional stacking.
#    b) local branches whose upstream is gone (squash-merged + remote-deleted)
#       must be cleaned up before starting new work.
# The override works from the hook's environment or inline in the command
# itself (`AGENTKIT_ALLOW_BRANCH_STACKING=1 git checkout -b …`) — inline
# assignments never reach the hook process, so honor them from the text.
STACKING_OK="${AGENTKIT_ALLOW_BRANCH_STACKING:-0}"
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])AGENTKIT_ALLOW_BRANCH_STACKING=1([[:space:];&|]|$)'; then
	STACKING_OK=1
fi

if echo "$STRIPPED" | grep -qiE '\bgit\b.*(checkout\s+-b|switch\s+-c)\b'; then
	DEFAULT_BRANCH=$(tgit symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
	CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
	if [[ -n "$CURRENT_BRANCH" && "$STACKING_OK" != "1" ]]; then
		ON_BASE=false
		for base in "$DEFAULT_BRANCH" "${PROTECTED_BRANCHES[@]+"${PROTECTED_BRANCHES[@]}"}" dev; do
			[[ -n "$base" && "$CURRENT_BRANCH" == "$base" ]] && ON_BASE=true
		done
		if [[ "$ON_BASE" == false ]]; then
			deny "BLOCKED: The targeted repo is on feature branch '${CURRENT_BRANCH}'. Cut new branches from the freshly pulled default branch (squash merges make stacked branches conflict once the first MR merges). Run: git checkout ${DEFAULT_BRANCH:-main} && git pull, then create the branch. Intentional stacking: prefix the command with AGENTKIT_ALLOW_BRANCH_STACKING=1.${TARGET_NOTE}"
		fi
	fi
	tgit fetch -p --quiet 2>/dev/null || true
	# `git branch -vv` prefixes a branch checked out in ANOTHER worktree with
	# `+` and the current branch with `*`, so a bare `$1` prints that marker
	# instead of the branch name — and worse, flags a branch that's actively
	# checked out elsewhere (normal under a worktree-per-branch workflow) as
	# stale clutter. Exclude `+` lines (active elsewhere, not deletable here)
	# and take $2 when the current-branch `*` marker is present.
	GONE=$(tgit branch -vv 2>/dev/null | grep ': gone]' | grep -v '^+ ' | awk '{print ($1=="*") ? $2 : $1}' | tr '\n' ' ' || true)
	if [[ -n "${GONE// /}" ]]; then
		deny "BLOCKED: Stale local branches with deleted upstreams: ${GONE}. Clean up before starting new work: git branch -vv | grep ': gone]' | grep -v '^+ ' | awk '{print (\$1=="*")?\$2:\$1}' | xargs -r git branch -D${TARGET_NOTE}"
	fi
fi

# 8. Stale branch protection — warn when creating a branch from a stale base
if echo "$STRIPPED" | grep -qiE '\bgit\b.*(checkout\s+-b|switch\s+-c)\b'; then
	CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
	for branch in "${PROTECTED_BRANCHES[@]+"${PROTECTED_BRANCHES[@]}"}"; do
		if [[ "$CURRENT_BRANCH" == "$branch" ]]; then
			tgit fetch origin "$branch" --quiet 2>/dev/null || true
			LOCAL_SHA=$(tgit rev-parse "$branch" 2>/dev/null || echo "")
			REMOTE_SHA=$(tgit rev-parse "origin/$branch" 2>/dev/null || echo "")
			if [[ -n "$LOCAL_SHA" && -n "$REMOTE_SHA" && "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
				BEHIND=$(tgit rev-list --count "$branch..origin/$branch" 2>/dev/null || echo "0")
				if [[ "$BEHIND" -gt 0 ]]; then
					deny "BLOCKED: Your local '${branch}' is ${BEHIND} commit(s) behind origin/${branch}. Run 'git pull origin ${branch}' first to avoid creating a branch from stale code. This prevents merge conflicts and wasted rebases.${TARGET_NOTE}"
				fi
			fi
		fi
	done
fi

# 10. Branch WIP cap. mr-police caps open merge requests at one, but an agent
#     that simply never opens an MR never meets that gate — measured on one
#     repository, eleven unmerged branches against a single MR. Branch creation
#     is the chokepoint that catches it. "Unmerged" is a forge question, never
#     a topology one (see lib/forge-branches.sh); a forge that cannot answer
#     allows, because blocking on a network hiccup is worse than the sprawl.
BRANCH_WIP_RAW="${AGENTKIT_BRANCH_WIP_MAX:-1}"
INLINE_WIP_MAX=$(echo "$COMMAND" | grep -oE '(^|[[:space:];&|])AGENTKIT_BRANCH_WIP_MAX=[^[:space:];&|]+' | head -1 | sed -E 's/.*=//' || true)
[[ -n "$INLINE_WIP_MAX" ]] && BRANCH_WIP_RAW="$INLINE_WIP_MAX"

# A typo must never read as `off`: a guard you can switch off by mistyping it
# is the failure this rule exists to close. An unusable value falls back to the
# default and says so.
WIP_BAD_VALUE=""
BRANCH_WIP_MAX="$BRANCH_WIP_RAW"
if [[ "$BRANCH_WIP_RAW" != "off" ]] && [[ ! "$BRANCH_WIP_RAW" =~ ^[1-9][0-9]*$ ]]; then
	WIP_BAD_VALUE="$BRANCH_WIP_RAW"
	BRANCH_WIP_MAX=1
fi
WIP_WARN=""
if [[ -n "$WIP_BAD_VALUE" ]]; then
	WIP_WARN="AGENTKIT_BRANCH_WIP_MAX='${WIP_BAD_VALUE}' is not a positive integer or 'off', so it was ignored and the default of 1 used. "
fi

# A branch a worktree is holding is live work — under one worktree per agent it
# is another agent's — so counting it would refuse agent B a branch because
# agent A holds one, and would name a branch whose deletion destroys a live
# tree. Rule 7 excludes those for the same reason.
wip_branch_unattended() {
	local ahead
	case "$WIP_TREES" in
	*"|$1|"*) return 1 ;;
	esac
	ahead=$(tgit rev-list --count "$WIP_BASE..$1" 2>/dev/null || echo 0)
	[[ "${ahead:-0}" -gt 0 ]]
}

WIP_LIB="${BASH_SOURCE[0]%/*}/lib/forge-branches.sh"
if [[ "$BRANCH_WIP_MAX" =~ ^[1-9][0-9]*$ ]] && [[ -r "$WIP_LIB" ]] \
	&& echo "$STRIPPED" | grep -qiE '\bgit\b.*(checkout\s+-b|switch\s+-c)\b'; then
	# shellcheck source=lib/forge-branches.sh
	source "$WIP_LIB"
	WIP_DEFAULT=$(tgit symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
	[[ -n "$WIP_DEFAULT" ]] || WIP_DEFAULT="main"
	WIP_BASE="$WIP_DEFAULT"
	if tgit show-ref --verify --quiet "refs/remotes/origin/$WIP_DEFAULT" 2>/dev/null; then
		WIP_BASE="origin/$WIP_DEFAULT"
	fi
	WIP_TREES="|$(tgit worktree list --porcelain 2>/dev/null | awk '$1 == "branch" { sub(/^refs\/heads\//, "", $2); print $2 }' | tr '\n' '|' || true)"

	# No gone-upstream test here: rule 7 refuses outright on a gone branch that
	# no worktree holds, and one a worktree does hold is dropped just below, so
	# a check for it could never change an outcome.
	WIP_CANDIDATES=""
	while IFS= read -r wip_branch; do
		[[ -n "$wip_branch" && "$wip_branch" != "$WIP_DEFAULT" ]] || continue
		if wip_branch_unattended "$wip_branch"; then
			WIP_CANDIDATES="$WIP_CANDIDATES $wip_branch"
		fi
	done < <(tgit for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)

	WIP_REPO=$(tgit rev-parse --show-toplevel 2>/dev/null || echo "")
	WIP_STATES=""
	WIP_ASKED=false
	if [[ -n "$WIP_REPO" ]] && agentkit_detect_forge "$WIP_REPO"; then
		if WIP_STATES=$(agentkit_forge_branch_states "$WIP_REPO"); then
			WIP_ASKED=true
		fi
	fi

	WIP_LIST=""
	WIP_COUNT=0
	for wip_branch in $WIP_CANDIDATES; do
		if [[ "$WIP_ASKED" == true ]]; then
			case "$(agentkit_branch_state "$wip_branch" "$WIP_STATES")" in
			merged | closed) continue ;;
			esac
		fi
		WIP_COUNT=$((WIP_COUNT + 1))
		WIP_LIST="$WIP_LIST $wip_branch"
	done

	if [[ "$WIP_COUNT" -ge "$BRANCH_WIP_MAX" ]]; then
		if [[ "$WIP_ASKED" == true ]]; then
			deny "${WIP_WARN}BLOCKED: ${WIP_COUNT} branch(es) in this repo are unfinished —${WIP_LIST}. The forge says each is either open or has never had a change raised from it, and no worktree is holding any of them. Finish one before starting another: open its MR/PR and get it merged. Only if one is genuinely dead, confirm with 'git worktree list' and 'git log' first, then delete it. Concurrent work: prefix the command with AGENTKIT_BRANCH_WIP_MAX=<n>, or AGENTKIT_BRANCH_WIP_MAX=off to switch the cap off.${TARGET_NOTE}"
		fi
		# Silence would read as a clean repository. A repo with no remote has no
		# forge to be unreachable, so that one stays quiet instead.
		if tgit remote get-url origin >/dev/null 2>&1; then
			advise "${WIP_WARN}UNCHECKED: the branch WIP cap could not be applied — no reachable forge (gh/glab) for this repo. ${WIP_COUNT} branch(es) carry commits and no worktree, so they may be unfinished:${WIP_LIST}. Nothing local can tell a squash-merged branch from an abandoned one, so this is a reminder, not a verdict."
		fi
	fi
	if [[ -n "$WIP_WARN" ]]; then
		advise "${WIP_WARN}The cap ran at the default and found nothing to refuse."
	fi
fi

# 9. Merge-return branch hygiene (advisory — nudges, never blocks). Rule 7's
#    hard-deny only fires when NEW work starts (checkout -b / switch -c), so
#    stale merged branches linger unnoticed between a merge and the next
#    branch creation. Fire a non-blocking reminder at the OTHER natural
#    cleanup moment: returning to the default branch (checkout/switch to it,
#    without -b/-c) or pulling while already on it. Same prune + gone
#    detection as rule 7; the command is always allowed through.
GIT_PULL_RE='\bgit([[:space:]]+(-[A-Za-z][^[:space:]]*|--[A-Za-z][A-Za-z0-9-]*(=[^[:space:]]+)?)([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+pull\b'
if echo "$STRIPPED" | grep -qiE '\bgit\b.*\b(checkout|switch|pull)\b' \
	&& ! echo "$STRIPPED" | grep -qiE '(checkout[[:space:]]+-b|switch[[:space:]]+-c)\b'; then
	DEFAULT_BRANCH=$(tgit symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
	if [[ -z "$DEFAULT_BRANCH" ]]; then
		for cand in "${PROTECTED_BRANCHES[@]+"${PROTECTED_BRANCHES[@]}"}"; do
			if tgit show-ref --verify --quiet "refs/heads/${cand}" 2>/dev/null; then
				DEFAULT_BRANCH="$cand"
				break
			fi
		done
	fi
	RETURN_TO_DEFAULT=false
	if [[ -n "$DEFAULT_BRANCH" ]]; then
		# checkout/switch to the default branch (flags allowed between)
		if echo "$STRIPPED" | grep -qiE "\b(checkout|switch)\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+${DEFAULT_BRANCH}\b"; then
			RETURN_TO_DEFAULT=true
		fi
		# pull while already sitting on the default branch
		if echo "$STRIPPED" | grep -qiE "$GIT_PULL_RE"; then
			CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
			[[ "$CURRENT_BRANCH" == "$DEFAULT_BRANCH" ]] && RETURN_TO_DEFAULT=true
		fi
	fi
	if [[ "$RETURN_TO_DEFAULT" == true ]]; then
		tgit fetch -p --quiet 2>/dev/null || true
		GONE=$(tgit branch -vv 2>/dev/null | grep ': gone]' | grep -v '^+ ' | awk '{print ($1=="*") ? $2 : $1}' | tr '\n' ' ' || true)
		if [[ -n "${GONE// /}" ]]; then
			advise "REMINDER: Stale local branches with deleted upstreams: ${GONE}. These were merged and their remotes deleted; now that you are back on ${DEFAULT_BRANCH}, clean them up: git branch -vv | grep ': gone]' | grep -v '^+ ' | awk '{print (\$1==\"*\")?\$2:\$1}' | xargs -r git branch -D"
		fi
	fi
fi

exit 0