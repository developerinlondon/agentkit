#!/usr/bin/env bash
# git-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: force push, --no-verify, Co-authored-by trailers, commits to protected branches
# Equivalent to: plugins/git-police.ts (OpenCode)
set -euo pipefail

PROTECTED_BRANCHES=("main" "master")
ALLOWED_REPOS=("brain" "deepbrain/brain")

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[[ -z "$COMMAND" ]] && exit 0

REPO_NAME=$(git remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+/[^/]+?)(\.git)?$|\1|' || echo "")
for allowed in "${ALLOWED_REPOS[@]}"; do
	if [[ "$REPO_NAME" == *"$allowed"* ]]; then
		exit 0
	fi
done

STRIPPED=$(echo "$COMMAND" |
	sed -E "s/<<-?[[:space:]]*['\"]?([A-Za-z_]+)['\"]?/\n\1_HEREDOC_START\n/g" |
	sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g" |
	sed -E "s/'[^']*'/''/g")

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

# 2. Block force push (--force, -f, but allow --force-with-lease)
if echo "$STRIPPED" | grep -qiE '\bgit\b.*\bpush\b.*(-f\b|--force\b|--force-with-lease\b)'; then
  deny "BLOCKED: Force push is forbidden. Force pushing rewrites history and can destroy work. If you truly need this, ask the user for explicit approval first."
fi

# 3. Block pushing directly to protected branches
for branch in "${PROTECTED_BRANCHES[@]}"; do
  if echo "$STRIPPED" | grep -qiE "\bgit\b.*\bpush\b.*\b${branch}\b"; then
    deny "BLOCKED: Pushing directly to '${branch}' is forbidden. Create a feature branch and raise a PR instead."
  fi
done

# 4. Block push when currently on a protected branch (even without branch name in command)
if echo "$STRIPPED" | grep -qiE '\bgit\b.*\bpush\b'; then
  CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
  for branch in "${PROTECTED_BRANCHES[@]}"; do
    if [[ "$CURRENT_BRANCH" == "$branch" ]]; then
      deny "BLOCKED: You are on '${branch}'. Pushing from a protected branch is forbidden. Create a feature branch first: git checkout -b feat/your-feature-name"
    fi
  done
fi

# 5. Block Co-authored-by trailers in commit commands
if echo "$STRIPPED" | grep -qiE '\bgit\b.*\bcommit\b' && echo "$STRIPPED" | grep -qi 'co-authored-by'; then
  deny "BLOCKED: AI attribution trailers (Co-authored-by) are forbidden in commit messages. Do not add Co-authored-by, Signed-off-by, or other AI agent attribution lines. The commit author is whoever owns the git config. Remove the trailer and retry."
fi

# 6. Block direct commits to protected branches
if echo "$STRIPPED" | grep -qiE '\bgit\b.*\bcommit\b'; then
  CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
  for branch in "${PROTECTED_BRANCHES[@]}"; do
    if [[ "$CURRENT_BRANCH" == "$branch" ]]; then
      deny "BLOCKED: Committing directly to '${branch}' is forbidden. You are on the ${branch} branch. Create a feature branch first: git checkout -b feat/your-feature-name"
    fi
  done
fi

exit 0
