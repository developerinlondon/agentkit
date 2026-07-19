#!/usr/bin/env bash
# review-police.sh — Claude Code PreToolUse hook (matchers: Bash + MCP merges)
#
# Blocks a forge merge unless an independent review PASSED for exactly the
# commit that merge would land. The agent cannot clear a blocking finding by
# reasoning about it; the path is fix-properly-then-re-review.
#
# Why: on 2026-07-19 a reviewer returned "HIGH — don't expose the menu item
# yet", the merge was already running in parallel, the agent judged the finding
# inert and shipped it, and it broke the user's machine exactly as predicted.
#
# WHAT THIS IS NOT: security. The review record lives in the repo and the agent
# can write it, so a determined agent can forge a pass. This hook makes the
# honest path correct, makes a stale or missing review mechanically impossible
# to merge past, and leaves an out-of-repo audit trail when a record is used.
# Only forge-side required approvals can actually prevent a merge.
#
# Review record, written by the REVIEWING agent:
#   .agentkit/reviews/<source-branch-slug>.json
#     { "head_sha": "<full sha reviewed>",
#       "verdict":  "pass" | "blocked",
#       "findings": [ { "severity": "BLOCKER|HIGH|MEDIUM|LOW",
#                       "summary": "...", "resolved": true|false } ],
#       "user_consent": {            # ONLY the user may add this
#          "granted": true, "quote": "<their words>", "at": "<ISO>" } }
#
# The gate resolves the MR/PR's REAL source branch and head sha from the forge —
# never the local checkout, which says nothing about what is being merged.
set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

AUDIT="${HOME}/.agentkit/review-audit.log"

deny() {
	mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
	printf '%s\tDENY\tsession=%s\t%s\n' "$(date -Is)" "$SESSION" "${1//$'\n'/ }" >>"$AUDIT" 2>/dev/null || true
	jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
	exit 0
}

# --- MCP merge tools: no Bash to inspect, so refuse outright ---------------
# These bypass every command-shaped check. The CLI path is the reviewed path.
if [[ -n "$TOOL" && "$TOOL" != "Bash" ]]; then
	if echo "$TOOL" | grep -qiE 'merge_(pull_request|request)|pull_request_merge|mr_merge'; then
		deny "BLOCKED: merging through an MCP tool bypasses the review gate.

Use the CLI (\`glab mr merge\` / \`gh pr merge\`) so the merge is checked against
the review record for the commit being merged."
	fi
	exit 0
fi

[[ -z "$COMMAND" ]] && exit 0

# A run of flags, each optionally taking its own ARGUMENT (`-C <dir>`, `-R o/r`).
# Matching flags but not their arguments has now been a bug in this file twice.
ARG='([[:space:]]+-{1,2}[A-Za-z][^[:space:]]*([[:space:]]+[^-][^[:space:]]*)?)*'
# An actual HTTP caller, as opposed to a command that merely mentions a URL.
HTTP='(curl|wget|http|https|gh[[:space:]]+api|glab[[:space:]]+api|fetch|axios|requests\.)'

# --- Is this a merge attempt? ---------------------------------------------
# Flag-tolerant: `glab -R o/r mr merge`, `gh --repo o/r pr merge`,
# `glab mr --repo o/r merge` all count. Same shape as git-police's push regex.
FLAG='(\s+(-[A-Za-z]\S*|--[A-Za-z][A-Za-z0-9-]*(=\S+)?)(\s+[^-\s]\S*)?)*'
# NOTE: every match below is wrapped so a NON-match cannot abort the script.
# `grep -q … && is_merge=1` returns non-zero when the pattern misses, and under
# `set -e` that exits the hook silently — i.e. FAILS OPEN, allowing the merge.
# Caught by this file's own tests before it ever shipped; keep the `if` form.
is_merge=0
if echo "$COMMAND" | grep -qiE "\bglab${FLAG}[[:space:]]+mr${FLAG}[[:space:]]+merge\b"; then is_merge=1; fi
if echo "$COMMAND" | grep -qiE "\bgh${FLAG}[[:space:]]+pr${FLAG}[[:space:]]+merge\b"; then is_merge=1; fi
# REST paths, contiguous or split across variables (…/merge_requests/12/merge).
# …and only when something is actually CALLING it: grepping or editing a merge
# URL is not merging. Every check here matches raw command text, so requiring
# the verb narrows the mention-vs-do confusion rather than eliminating it.
if echo "$COMMAND" | grep -qiE 'merge_requests?/[0-9]+/merge|/pulls/[0-9]+/merge' &&
	echo "$COMMAND" | grep -qiE "$HTTP"; then is_merge=1; fi
# Split-variable REST forms: the URL is assembled at runtime, so look for a
# merge_requests/pulls reference AND a /merge path segment in the same command.
if echo "$COMMAND" | grep -qiE 'merge_requests?|/pulls?/' &&
	echo "$COMMAND" | grep -qiE '/merge\b|"\$\{?[A-Za-z_]+\}?/merge' &&
	echo "$COMMAND" | grep -qiE "$HTTP"; then is_merge=1; fi
# Gate on an actual `git push` — `-o` is ubiquitous (grep -o, curl -o, cc -o),
# so matching it bare denied commands that merely MENTIONED the pattern,
# including grepping for the rule this hook enforces. ${ARG} so a flag's own
# argument (`git -C <dir> push`) doesn't break the match.
if echo "$COMMAND" | grep -qiE "\bgit${ARG}[[:space:]]+push\b" &&
	echo "$COMMAND" | grep -qiE '(-o|--push-option)[= ][^ ]*merge_request\.merge'; then
	deny "BLOCKED: a merge-on-pipeline push option queues a merge no review has seen.

Push the branch without the merge push-option, then merge explicitly so the
gate can check the commit that actually lands."
fi
[[ $is_merge -eq 1 ]] || exit 0

# Auto-merge queues the merge for a LATER head — the sha we check now is not
# the sha that lands. Refuse the mode rather than pretend to gate it.
if echo "$COMMAND" | grep -qiE '(--auto|--merge-when-pipeline-succeeds|--when-pipeline-succeeds)\b'; then
	deny "BLOCKED: auto-merge cannot be review-gated.

It merges a future head that no review has seen. Wait for the pipeline, then
merge explicitly so the gate can check the commit that actually lands."
fi

# --- Resolve WHAT is being merged, from the forge ---------------------------
# Fail CLOSED: if the target cannot be resolved, the gate denies. An
# unresolvable merge is exactly when a mistake is most likely.
REPO_DIR=$(echo "$COMMAND" | sed -nE 's/^[[:space:]]*cd[[:space:]]+([^[:space:];&|]+).*/\1/p' | head -1)
[[ -z "$REPO_DIR" ]] && REPO_DIR="$PWD"

ARG='([[:space:]]+-{1,2}[A-Za-z][^[:space:]]*([[:space:]]+[^-][^[:space:]]*)?)*'
MR_ID=$(echo "$COMMAND" | grep -oiE "\b(mr|pr)${ARG}[[:space:]]+merge${ARG}[[:space:]]+[0-9]+" | grep -oE '[0-9]+$' | head -1 || true)
if [[ -z "$MR_ID" ]]; then
	MR_ID=$(echo "$COMMAND" | grep -oiE 'merge_requests?/[0-9]+|/pulls/[0-9]+' | grep -oE '[0-9]+' | head -1 || true)
fi
REPO_FLAG=$(echo "$COMMAND" | grep -oiE '(-R|--repo)[= ]+[^ ]+' | head -1 | sed -E 's/^(-R|--repo)[= ]+//' || true)

forge_json() {
	if echo "$COMMAND" | grep -qiE '\bgh\b|/pulls/'; then
		gh pr view "$MR_ID" ${REPO_FLAG:+--repo "$REPO_FLAG"} \
			--json headRefName,headRefOid 2>/dev/null |
			jq -r '"\(.headRefName)\t\(.headRefOid)"'
	else
		glab mr view "$MR_ID" ${REPO_FLAG:+--repo "$REPO_FLAG"} --output json 2>/dev/null |
			jq -r '"\(.source_branch)\t\(.sha // .diff_refs.head_sha)"'
	fi
}

BRANCH=""
HEAD_SHA=""
if [[ -n "$MR_ID" ]]; then
	RESOLVED=$(cd "$REPO_DIR" 2>/dev/null && forge_json || true)
	BRANCH=$(echo "$RESOLVED" | cut -f1)
	HEAD_SHA=$(echo "$RESOLVED" | cut -f2)
fi

if [[ -z "$BRANCH" || -z "$HEAD_SHA" || "$BRANCH" == "null" || "$HEAD_SHA" == "null" ]]; then
	deny "BLOCKED: cannot resolve what this merge would land, so it cannot be gated.

  command dir: $REPO_DIR
  mr/pr id:    ${MR_ID:-<none found>}

The gate must read the merge request's SOURCE BRANCH and HEAD SHA from the
forge — the local checkout says nothing about the commit being merged. Run the
merge from the repo directory with an explicit MR/PR number, with the forge CLI
authenticated."
fi

SLUG=$(echo "$BRANCH" | sed 's#/#__#g')
RECORD="$REPO_DIR/.agentkit/reviews/$SLUG.json"

if [[ ! -f "$RECORD" ]]; then
	deny "BLOCKED: no review record for the branch this merge would land.

  merge request: !${MR_ID}
  source branch: $BRANCH
  head sha:      $HEAD_SHA

Run the review (code-reviewer subagent) against THAT branch, have it write its
verdict to .agentkit/reviews/$SLUG.json (head_sha, verdict, findings), then
merge. Reviews gate merges — they never run alongside them."
fi

REVIEWED_SHA=$(jq -r '.head_sha // empty' "$RECORD" 2>/dev/null || true)
if [[ "$REVIEWED_SHA" != "$HEAD_SHA" ]]; then
	deny "BLOCKED: the review for '$BRANCH' does not cover the commit being merged.

  reviewed: ${REVIEWED_SHA:-<unset/unreadable>}
  merging:  $HEAD_SHA

Commits landed after the review, or the record is malformed. Re-review the
current head and update .agentkit/reviews/$SLUG.json."
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
		mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
		printf '%s\tCONSENT-OVERRIDE\tsession=%s\tbranch=%s\tsha=%s\tquote=%s\n' \
			"$(date -Is)" "$SESSION" "$BRANCH" "$HEAD_SHA" "${CONSENT_QUOTE//$'\n'/ }" \
			>>"$AUDIT" 2>/dev/null || true
		exit 0
	fi
	deny "BLOCKED: the review of '$BRANCH' has not passed.

  verdict: $VERDICT
${BLOCKING:+  unresolved blocking findings:
$BLOCKING}

You may NOT merge past this by judging a finding harmless — that is exactly how
a 'don't expose this yet' HIGH reached the user's machine and broke it.

THE PATH IS: fix it properly, then re-review.
  1. Fix the finding at its root — not a workaround, not a toggle that hides
     it, not a comment explaining why it is acceptable.
  2. Re-run the reviewer against the NEW head sha; it writes a fresh record.
  3. Merge once that record passes.

Do NOT hand this to the user as a decision. They are not a queue for findings
you would rather not fix. Escalate ONLY when the finding genuinely cannot be
fixed here — an upstream or platform limitation, not 'this is hard' or 'this is
low impact' — and say plainly WHY. If they then tell you in writing to ship it,
record their words:
     .user_consent = { granted: true, quote: \"<their words>\", at: \"<ISO>\" }
Fabricating that consent is forging the user's approval — don't."
fi

mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
printf '%s\tPASS\tsession=%s\tbranch=%s\tsha=%s\n' "$(date -Is)" "$SESSION" "$BRANCH" "$HEAD_SHA" \
	>>"$AUDIT" 2>/dev/null || true
exit 0
