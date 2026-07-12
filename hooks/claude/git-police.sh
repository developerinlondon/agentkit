#!/usr/bin/env bash
# git-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: force push, --no-verify, AI attribution (commit trailers AND MR/PR/issue
# content), commits to protected branches, stale branch creation
# Equivalent to: plugins/git-police.ts (OpenCode)
set -euo pipefail

PROTECTED_BRANCHES=("main" "master")
AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[[ -z "$COMMAND" ]] && exit 0

load_allowed_repos() {
	[[ -f "$AGENTKIT_CONFIG" ]] || return
	local in_section=false
	while IFS= read -r line; do
		if [[ "$line" =~ ^[[:space:]]*branch-protection: ]]; then
			in_section=true
			continue
		fi
		if [[ "$in_section" == true && "$line" =~ ^[[:space:]]*allowed-repos: ]]; then
			continue
		fi
		if [[ "$in_section" == true && "$line" =~ ^[[:space:]]*-[[:space:]]+(.*) ]]; then
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
	for allowed in "${ALLOWED_REPOS[@]}"; do
		if [[ "$REPO_NAME" == *"$allowed"* ]]; then
			exit 0
		fi
	done
fi

deny() {
	local reason="$1"
	jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
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
	for branch in "${PROTECTED_BRANCHES[@]}"; do
		if echo "$STRIPPED" | grep -qiE "${GIT_PUSH_RE}.*\b${branch}\b"; then
			deny "BLOCKED: Pushing directly to '${branch}' is forbidden. Create a feature branch and raise a PR instead."
		fi
	done
fi

# 4. Block push when the targeted repo is on a protected branch (even without
#    branch name in command) — same origin scoping as rule 3.
if [[ -z "$PUSH_REMOTE" || "$PUSH_REMOTE" == "origin" ]] \
	&& echo "$STRIPPED" | grep -qiE "$GIT_PUSH_RE"; then
	CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
	for branch in "${PROTECTED_BRANCHES[@]}"; do
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
	for branch in "${PROTECTED_BRANCHES[@]}"; do
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
		for base in "$DEFAULT_BRANCH" "${PROTECTED_BRANCHES[@]}" dev; do
			[[ -n "$base" && "$CURRENT_BRANCH" == "$base" ]] && ON_BASE=true
		done
		if [[ "$ON_BASE" == false ]]; then
			deny "BLOCKED: The targeted repo is on feature branch '${CURRENT_BRANCH}'. Cut new branches from the freshly pulled default branch (squash merges make stacked branches conflict once the first MR merges). Run: git checkout ${DEFAULT_BRANCH:-main} && git pull, then create the branch. Intentional stacking: prefix the command with AGENTKIT_ALLOW_BRANCH_STACKING=1."
		fi
	fi
	tgit fetch -p --quiet 2>/dev/null || true
	GONE=$(tgit branch -vv 2>/dev/null | grep ': gone]' | awk '{print $1}' | tr '\n' ' ' || true)
	if [[ -n "${GONE// /}" ]]; then
		deny "BLOCKED: Stale local branches with deleted upstreams: ${GONE}. Clean up before starting new work: git branch -vv | awk '/: gone]/ {print \$1}' | xargs -r git branch -D"
	fi
fi

# 8. Stale branch protection — warn when creating a branch from a stale base
if echo "$STRIPPED" | grep -qiE '\bgit\b.*(checkout\s+-b|switch\s+-c)\b'; then
	CURRENT_BRANCH=$(tgit symbolic-ref --short HEAD 2>/dev/null || echo "")
	for branch in "${PROTECTED_BRANCHES[@]}"; do
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

exit 0