#!/usr/bin/env bash
# git-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: force push, --no-verify, AI attribution (commit trailers AND MR/PR/issue
# content), commits to protected branches, stale branch creation
# Equivalent to: plugins/git-police.ts (OpenCode)
set -euo pipefail

# bash 3.2 cannot parse `(` inside [[ =~ ]], and this is a PreToolUse Bash
# hook: a parse error denies EVERY command, with no way to switch it off.
RE_YAML_ITEM='^[[:space:]]*-[[:space:]]+(.*)'

PROTECTED_BRANCHES=("main" "master")
AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"

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
	echo "${dir/#\~/$HOME}"
}
TARGET_DIR=$(git_target_dir "$STRIPPED")

# git scoped to the targeted repo (cwd when the command names none).
tgit() {
	git ${TARGET_DIR:+-C "$TARGET_DIR"} "$@"
}

if [[ ${#ALLOWED_REPOS[@]} -gt 0 ]]; then
	REPO_NAME=$(tgit remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+/[^/]+?)(\.git)?$|\1|' || echo "")
	for allowed in "${ALLOWED_REPOS[@]+"${ALLOWED_REPOS[@]}"}"; do
		if [[ "$REPO_NAME" == *"$allowed"* ]]; then
			exit 0
		fi
	done
fi

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
		WORKTREE_COUNT=$(tgit worktree list 2>/dev/null | wc -l | tr -d ' ')
		if [[ "${WORKTREE_COUNT:-0}" -gt 1 ]]; then
			REPO_BASE=$(basename "$(tgit rev-parse --show-toplevel 2>/dev/null || echo repo)")
			deny "BLOCKED: creating a branch in a shared clone. This checkout has ${WORKTREE_COUNT} worktrees, so another agent may be working in it and a checkout swaps the tree under them. Create a worktree instead:

  git worktree add ../${REPO_BASE}-wt/<name> -b <branch> origin/<default>

Intentional (nobody else is in this clone): prefix with AGENTKIT_ALLOW_SHARED_BRANCH=1."
		fi
	fi
fi
#    branch name in command) — same origin scoping as rule 3.
if [[ -z "$PUSH_REMOTE" || "$PUSH_REMOTE" == "origin" ]] \
	&& echo "$STRIPPED" | grep -qiE "$GIT_PUSH_RE"; then
	CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
	for branch in "${PROTECTED_BRANCHES[@]+"${PROTECTED_BRANCHES[@]}"}"; do
		if [[ "$CURRENT_BRANCH" == "$branch" ]]; then
			deny "BLOCKED: You are on '${branch}'. Pushing from a protected branch is forbidden. Create a feature branch first: git checkout -b feat/your-feature-name"
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
		DEFAULT_BRANCH=$(tgit symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
	fi
	if [[ -z "$DEFAULT_BRANCH" ]]; then
		for cand in main master; do
			if tgit show-ref --verify --quiet "refs/remotes/origin/${cand}"; then
				DEFAULT_BRANCH="$cand"
				break
			fi
		done
	fi
	if [[ -n "$DEFAULT_BRANCH" ]]; then
		tgit fetch --quiet origin "$DEFAULT_BRANCH" 2>/dev/null || true
		BEHIND=$(tgit rev-list --count "HEAD..origin/${DEFAULT_BRANCH}" 2>/dev/null || echo 0)
		if [[ "${BEHIND:-0}" -gt 0 ]]; then
			deny "BLOCKED: Your branch is ${BEHIND} commit(s) behind origin/${DEFAULT_BRANCH}. Merge the latest ${DEFAULT_BRANCH} before pushing: git fetch origin && git merge origin/${DEFAULT_BRANCH} — resolve any conflicts, re-run the repo's gates, then push. Intentional stale push: prefix the command with AGENTKIT_ALLOW_STALE_PUSH=1. MRs targeting a different branch: git config agentkit.integration-branch <branch>."
		fi
	fi
fi

# Detect `git commit` as a subcommand (not the literal substring "commit"
# inside a config key like `git config commit.gpgsign`).
GIT_COMMIT_RE='\bgit([[:space:]]+(-[A-Za-z][^[:space:]]*|--[A-Za-z][A-Za-z0-9-]*(=[^[:space:]]+)?)([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit\b'

# Commands that publish authored content to the forge — MR/PR/issue bodies,
# comments, release notes. Same no-AI-attribution rule as commit messages:
# everything published under the user's name is theirs, not the agent's.
FORGE_WRITE_RE='\bglab[[:space:]]+(mr|issue)[[:space:]]+(create|update|edit|note|comment)\b|\bgh[[:space:]]+(pr|issue|release)[[:space:]]+(create|edit|comment)\b'

# 5. Block AI attribution trailers / signatures in commit commands AND in
#    forge-content commands (MR/PR descriptions slipped through when this
#    was gated on `git commit` only).
#    $INPUT is the full PreToolUse JSON payload from stdin; the previous
#    version referenced an undefined $TOOL_INPUT and silently never matched.
if { echo "$STRIPPED" | grep -qiE "$GIT_COMMIT_RE" || echo "$STRIPPED" | grep -qiE "$FORGE_WRITE_RE"; } \
	&& echo "$INPUT" | grep -qiE 'co-authored-by|generated with \[claude code\]|🤖 generated|claude\.ai/code|claude\.com/claude-code|noreply@anthropic\.com'; then
	deny "BLOCKED: AI attribution is forbidden — in commit messages and in MR/PR/issue descriptions or comments alike. Do not add Co-authored-by, Signed-off-by, '🤖 Generated with [Claude Code]', claude.ai/code or claude.com/claude-code links, noreply@anthropic.com co-authors, or any other AI agent attribution. The author is whoever owns the git config. Remove the attribution and retry."
fi

# 6. Block direct commits to protected branches
if echo "$STRIPPED" | grep -qiE "$GIT_COMMIT_RE"; then
	CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
	for branch in "${PROTECTED_BRANCHES[@]+"${PROTECTED_BRANCHES[@]}"}"; do
		if [[ "$CURRENT_BRANCH" == "$branch" ]]; then
			deny "BLOCKED: Committing directly to '${branch}' is forbidden. You are on the ${branch} branch. Create a feature branch first: git checkout -b feat/your-feature-name"
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
			deny "BLOCKED: The targeted repo is on feature branch '${CURRENT_BRANCH}'. Cut new branches from the freshly pulled default branch (squash merges make stacked branches conflict once the first MR merges). Run: git checkout ${DEFAULT_BRANCH:-main} && git pull, then create the branch. Intentional stacking: prefix the command with AGENTKIT_ALLOW_BRANCH_STACKING=1."
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
		deny "BLOCKED: Stale local branches with deleted upstreams: ${GONE}. Clean up before starting new work: git branch -vv | grep ': gone]' | grep -v '^+ ' | awk '{print (\$1=="*")?\$2:\$1}' | xargs -r git branch -D"
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
					deny "BLOCKED: Your local '${branch}' is ${BEHIND} commit(s) behind origin/${branch}. Run 'git pull origin ${branch}' first to avoid creating a branch from stale code. This prevents merge conflicts and wasted rebases."
				fi
			fi
		fi
	done
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
			if tgit show-ref --verify --quiet "refs/heads/${cand}"; then
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