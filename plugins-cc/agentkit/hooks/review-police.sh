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
RAW_COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
SESSION=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

# TOKENISE the way a shell does, then match on tokens joined by newlines.
#
# Quoting is not the distinction that matters — POSITION is. Blanking quoted
# spans (the previous attempt) fixed commit messages but silently defeated the
# idiomatic REST forms, whose URLs are legitimately quoted: it turned a false
# positive into a fail-OPEN, which is the wrong direction for a gate.
#
# Tokenising separates the two. `git commit -m "git push -o …"` yields the
# message as ONE token, so it can never be read as the command word `push` or
# the flag `-o`; while `curl -X PUT ".../merge_requests/12/merge"` keeps the
# URL as a token whose value still matches. Checks below therefore anchor on
# tokens (a token that IS `push`, a token that IS `-o`), not on substrings of
# the raw line.
#
# The boundary this draws is "quoted text is DATA" — which is wrong for exactly
# one family: a quoted string that a shell then EXECUTES. `bash -c "glab mr
# merge 999"` would otherwise collapse to one inert token and fail open.
#
# The rule, stated exactly as implemented: IF the command mentions a shell
# interpreter (bash/sh/zsh/dash/ksh, by BASENAME so /bin/bash counts) or `eval`
# ANYWHERE, then EVERY token of that command is re-tokenised and added to the
# set, recursively. Not "the argument of -c" — that shape has been narrowed
# wrong twice (`bash -lc`, `bash -e -u -c`, `bash -c -- …`, `bash <<< …`,
# `echo … | bash` all evaded it), and enumerating shell calling conventions is
# a losing game. Once a shell is in the line, treat every string in it as
# potentially executed.
#
# This deliberately OVER-expands: `bash -c "echo hi" && git commit -m "glab mr
# merge 12 is gated"` denies. That is the correct direction for a gate — a
# false deny is an inconvenience, a missed merge is the failure this exists to
# prevent. Commands with no shell word (the overwhelming majority, including
# every plain `git commit -m "…"`) are unaffected, which is what keeps the
# commit-message false positives fixed.
#
# Depth is bounded, and exhausting the bound falls back to whitespace-splitting
# the remaining text rather than returning it unexpanded — a 5-deep nest must
# not become a hole.
#
# If tokenising is unavailable or the line does not parse (unbalanced quotes),
# fall back to whitespace-splitting with quote characters stripped. Keeping the
# quotes glued on (`"glab`) makes exact-token matching miss, which fails OPEN —
# the one direction this must never take.
COMMAND=$(printf '%s' "$RAW_COMMAND" | python3 -c '
import os, shlex, sys

SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "eval"}
DEPTH = 6

def split(raw):
    lex = shlex.shlex(raw, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ""  # a `#` in a URL fragment is not a comment
    return list(lex)

def rough(raw):
    # chr(34)/chr(39) rather than literal quote characters: this script is
    # embedded in a single-quoted shell string, where a literal quote silently
    # ends the block. That broke the hook once — and a hook that dies emits no
    # decision, which the harness reads as ALLOW. Quote-free by construction.
    drop = str.maketrans("", "", chr(34) + chr(39) + chr(92))
    return [t.translate(drop) for t in raw.split()]

def expand(raw, depth=0):
    try:
        toks = split(raw)
    except ValueError:
        return rough(raw)
    if not any(os.path.basename(t) in SHELLS for t in toks):
        return toks
    if depth >= DEPTH:
        return toks + rough(raw)
    out = list(toks)
    for t in toks:
        if t != raw:
            out.extend(expand(t, depth + 1))
    return out

raw = sys.stdin.read()
print("\n".join(expand(raw)))
' 2>/dev/null || printf '%s' "$RAW_COMMAND" | tr -s '[:space:]' '\n' | tr -d '\042\047\134')
# Some checks still need the flat line (a URL split across variables never
# survives tokenisation as one piece); those use RAW_COMMAND deliberately.

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

# An actual HTTP caller, as opposed to a command that merely mentions a URL.
HTTP='^(curl|wget|http|https|fetch|axios)$'

# Token predicates. `has tok` is an EXACT token match, which is the whole point
# of tokenising: the word `push` inside a commit message is one token of prose,
# never the command word.
has() { printf '%s' "$COMMAND" | grep -qxF -- "$1"; }
# Any token matching a regex (URLs keep their value through tokenisation).
tok_match() { printf '%s' "$COMMAND" | grep -qiE -- "$1"; }
# The token following the first occurrence of a given token.
after() { printf '%s' "$COMMAND" | awk -v k="$1" 'p { print; exit } $0 == k { p = 1 }'; }

# --- Is this a merge attempt? ---------------------------------------------
# Subcommands are separate tokens, so flags and their arguments no longer need
# tolerating in a regex — `glab -R o/r mr merge` and `glab mr --repo o/r merge`
# both simply contain the tokens glab, mr, merge.
# NOTE: every match below is wrapped so a NON-match cannot abort the script.
# `grep -q … && is_merge=1` returns non-zero when the pattern misses, and under
# `set -e` that exits the hook silently — i.e. FAILS OPEN, allowing the merge.
is_merge=0
if has glab && has mr && has merge; then is_merge=1; fi
if has gh && has pr && has merge; then is_merge=1; fi
# A REST merge: a token carrying the merge path, called by an HTTP client (or
# `gh api` / `glab api`). Grepping or editing such a URL is not merging it.
if tok_match 'merge_requests?/[0-9]+/merge|/pulls/[0-9]+/merge' &&
	{ tok_match "$HTTP" || { has api && { has gh || has glab; }; }; }; then is_merge=1; fi
# Split-variable REST forms: the URL is assembled at runtime, so no single token
# carries the whole path — this one check reads RAW_COMMAND deliberately, and is
# narrowed by requiring an HTTP caller among the TOKENS.
if echo "$RAW_COMMAND" | grep -qiE 'merge_requests?|/pulls?/' &&
	echo "$RAW_COMMAND" | grep -qiE '/merge\b|\$\{?[A-Za-z_]+\}?/merge' &&
	tok_match "$HTTP"; then is_merge=1; fi
# Gate on an actual `git push` — `-o` is ubiquitous (grep -o, curl -o, cc -o),
# so matching it bare denied commands that merely MENTIONED the pattern,
# including grepping for the rule this hook enforces. As tokens: the option's
# value is the token after `-o`, or is fused into `--push-option=…`.
# Scan EVERY option, not just the first: `git push -o ci.skip -o
# merge_request.merge_when_pipeline_succeeds` is the idiomatic multi-option
# form, and reading only the token after the first `-o` let it through.
# A push-option value counts when its PREDECESSOR token is -o/--push-option
# (covering both the short and the space-separated long form), or when it is
# fused as --push-option=<value>.
push_option_merge() {
	printf '%s' "$COMMAND" | awk '
		/^--push-option=.*merge_request\.merge/ { found = 1 }
		prev == "-o" || prev == "--push-option" {
			if ($0 ~ /^merge_request\.merge/) found = 1
		}
		{ prev = $0 }
		END { exit(found ? 0 : 1) }
	'
}
if has git && has push && push_option_merge; then
	deny "BLOCKED: a merge-on-pipeline push option queues a merge no review has seen.

Push the branch without the merge push-option, then merge explicitly so the
gate can check the commit that actually lands."
fi
[[ $is_merge -eq 1 ]] || exit 0

# Auto-merge queues the merge for a LATER head — the sha we check now is not
# the sha that lands. Refuse the mode rather than pretend to gate it.
if tok_match '^--(auto|merge-when-pipeline-succeeds|when-pipeline-succeeds)$'; then
	deny "BLOCKED: auto-merge cannot be review-gated.

It merges a future head that no review has seen. Wait for the pipeline, then
merge explicitly so the gate can check the commit that actually lands."
fi

# --- Resolve WHAT is being merged, from the forge ---------------------------
# Fail CLOSED: if the target cannot be resolved, the gate denies. An
# unresolvable merge is exactly when a mistake is most likely.
REPO_DIR=$(after cd)
[[ -z "$REPO_DIR" ]] && REPO_DIR="$PWD"

# The FIRST NUMERIC token after `merge` — not the immediately-next one. Flags
# before `merge` are separate tokens and so take care of themselves, but a flag
# AFTER it (`gh pr merge --squash 999`) still sits between the verb and the id.
# Extraction losing the id denies honest merges with a misleading reason.
MR_ID=$(printf '%s' "$COMMAND" | awk '
	p && /^[0-9]+$/ { print; exit }
	$0 == "merge" { p = 1 }
' || true)
if [[ -z "$MR_ID" ]]; then
	MR_ID=$(printf '%s' "$COMMAND" | grep -oiE 'merge_requests?/[0-9]+|/pulls/[0-9]+' | grep -oE '[0-9]+' | head -1 || true)
fi
REPO_FLAG=$(after -R)
[[ -z "$REPO_FLAG" ]] && REPO_FLAG=$(after --repo)
[[ -z "$REPO_FLAG" ]] && REPO_FLAG=$(printf '%s' "$COMMAND" | sed -nE 's/^--repo=(.+)$/\1/p' | head -1 || true)

forge_json() {
	if has gh || tok_match '/pulls/'; then
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
