#!/usr/bin/env bash
# review-police.sh — Claude Code PreToolUse hook (matcher: Bash)
#
# Blocks a forge merge unless an independent review has PASSED for exactly the
# commit being merged. The agent cannot clear a blocking finding by reasoning
# about it; only the user can, and only in writing.
#
# Why this exists: on 2026-07-19 a reviewer returned "HIGH — don't expose the
# menu item yet", the merge had already been started in parallel, and the agent
# judged the finding inert and shipped it. The feature then broke the user's
# machine exactly as the reviewer predicted. Severity is the reviewer's call;
# the override is the user's. Neither belongs to the agent.
#
# Contract (a review record is JSON, written by the REVIEWING agent):
#   .agentkit/reviews/<branch-slug>.json
#     { "head_sha": "<full sha reviewed>",
#       "reviewer":  "<agent/session id — must differ from the merger>",
#       "verdict":   "pass" | "blocked",
#       "findings":  [ { "severity": "BLOCKER|HIGH|MEDIUM|LOW",
#                        "summary": "...", "resolved": true|false } ],
#       "user_consent": {            # ONLY the user may add this
#          "granted": true,
#          "quote":  "<their words, verbatim>",
#          "at":     "<ISO timestamp>" } }
#
# A merge passes when: the record exists, its head_sha equals the branch head
# being merged (a stale review is no review), and no unresolved BLOCKER/HIGH
# remains — or the user granted consent in writing for that same sha.
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

# Merge attempts, however they are spelled: glab/gh CLIs and the REST calls
# that bypass them (the agent has reached for curl when a CLI refused).
if ! echo "$COMMAND" | grep -qiE \
	'glab[[:space:]]+mr[[:space:]]+merge|gh[[:space:]]+pr[[:space:]]+merge|merge_requests?/[0-9]+/merge|/pulls/[0-9]+/merge'; then
	exit 0
fi

deny() {
	jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
	exit 0
}

# The repo the command targets: an explicit `cd <path> &&` prefix wins,
# otherwise the hook's cwd (mirrors mr-police's resolution).
REPO_DIR=$(echo "$COMMAND" | sed -nE 's/^[[:space:]]*cd[[:space:]]+([^[:space:];&|]+).*/\1/p' | head -1)
[[ -z "$REPO_DIR" ]] && REPO_DIR="$PWD"
[[ -d "$REPO_DIR" ]] || REPO_DIR="$PWD"

BRANCH=$(git -C "$REPO_DIR" branch --show-current 2>/dev/null || true)
[[ -z "$BRANCH" ]] && exit 0

# Never gate the merge of a branch that has no local checkout context.
HEAD_SHA=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)
[[ -z "$HEAD_SHA" ]] && exit 0

SLUG=$(echo "$BRANCH" | tr '/' '-')
RECORD="$REPO_DIR/.agentkit/reviews/$SLUG.json"

if [[ ! -f "$RECORD" ]]; then
	deny "BLOCKED: no review record for '$BRANCH'.

A merge requires an independent review of the exact commit being merged.
Run the review (code-reviewer subagent), have it write its verdict to
  .agentkit/reviews/$SLUG.json
with head_sha, verdict, and findings, THEN merge.

Reviews gate merges — they do not run alongside them. If the review already
ran, it did not record a verdict, which means nothing downstream can verify
what it found."
fi

REVIEWED_SHA=$(jq -r '.head_sha // empty' "$RECORD" 2>/dev/null || true)
if [[ "$REVIEWED_SHA" != "$HEAD_SHA" ]]; then
	deny "BLOCKED: the review for '$BRANCH' is stale.

  reviewed: ${REVIEWED_SHA:-<unset>}
  merging:  $HEAD_SHA

Commits landed after the review. Re-review the current head and update
.agentkit/reviews/$SLUG.json. A review of an older commit says nothing about
the code you are about to merge."
fi

BLOCKING=$(jq -r '
  [ .findings[]?
    | select((.severity // "" | ascii_upcase) as $s
             | $s == "BLOCKER" or $s == "HIGH")
    | select((.resolved // false) == false)
    | "  - \(.severity | ascii_upcase): \(.summary // "(no summary)")"
  ] | join("\n")' "$RECORD" 2>/dev/null || true)

VERDICT=$(jq -r '.verdict // "blocked"' "$RECORD" 2>/dev/null || echo blocked)
CONSENT=$(jq -r '.user_consent.granted // false' "$RECORD" 2>/dev/null || echo false)
CONSENT_QUOTE=$(jq -r '.user_consent.quote // empty' "$RECORD" 2>/dev/null || true)

if [[ -n "$BLOCKING" || "$VERDICT" != "pass" ]]; then
	if [[ "$CONSENT" == "true" && -n "$CONSENT_QUOTE" ]]; then
		exit 0 # the user overrode it, in writing, for this sha
	fi
	deny "BLOCKED: the review of '$BRANCH' has not passed.

  verdict: $VERDICT
${BLOCKING:+  unresolved blocking findings:
$BLOCKING}

You may NOT merge past this by judging a finding harmless — that is exactly
how a 'don't expose this yet' HIGH reached the user's machine and broke it.

THE PATH IS: fix it properly, then re-review.
  1. Fix the finding at its root — not a workaround, not a toggle that hides
     it, not a comment explaining why it is acceptable.
  2. Re-run the reviewer against the NEW head sha; it writes a fresh record.
  3. Merge once that record passes.

Do NOT hand this to the user as a decision. They are not a queue for findings
you would rather not fix. Escalate ONLY when the finding genuinely cannot be
fixed here — an upstream/platform limitation, not 'this is hard' or 'this is
low impact' — and say plainly WHY it cannot be fixed. If they then tell you in
writing to ship it, record their words:
     .user_consent = { granted: true, quote: \"<their words>\", at: \"<ISO>\" }
Fabricating that consent is forging the user's approval — don't."
fi

exit 0
