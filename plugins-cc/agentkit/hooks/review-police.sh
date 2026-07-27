#!/usr/bin/env bash
# review-police.sh — Claude Code PreToolUse hook (matchers: Bash + MCP merges)
#
# Blocks a forge merge unless review evidence PASSED for the forge-selected
# source head and current target. The agent cannot clear a blocking finding by
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
# Review record, written by the reviewing agent:
#   .agentkit/reviews/<source-branch-slug>.json
# If the exact target commit has .agentkit/review-policy.json, review-gate
# requires the context-bound v2 evidence shape documented in
# docs/review-process.md. Otherwise the bounded legacy head_sha/verdict/findings
# shape remains available for bootstrap.
#
# The gate resolves the change's real source and target from the forge. Strict
# policy comes only from the target Git object, never the source checkout.
set -euo pipefail

# A hook that DIES emits no decision, and the harness reads silence as ALLOW —
# so every abort path here is a fail-open. Two were reachable from the
# environment alone: `jq` missing (exit 127 on the first parse) and HOME unset
# (set -u on the audit path). Neither is exotic; both silently disarmed the
# gate. Refuse loudly instead of dying quietly.
# shellcheck source=lib/hook-input.sh
# Pure bash dirname: external `dirname` is missing when PATH is empty (the
# missing-jq fail-open probe), and a source failure under set -e would silence
# the gate. BASH_SOURCE is absolute when the harness invokes the script by path.
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
if ! command -v jq >/dev/null 2>&1; then
	printf '%s\n' '{"decision":"deny","reason":"BLOCKED: review-police cannot run — jq is not installed, so the merge cannot be checked against its review record. Install jq.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: review-police cannot run — jq is not installed, so the merge cannot be checked against its review record. Install jq."}}'
	exit 0
fi

agentkit_slurp_input
TOOL=$(agentkit_tool_name)
TOOL_FAMILY=$(agentkit_tool_family "$TOOL")
RAW_COMMAND=$(agentkit_command)
SESSION=$(agentkit_session_id)

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
# The rule, stated exactly as implemented: IF the command mentions any name in
# SHELLS below (by BASENAME, so /bin/bash counts) ANYWHERE, then EVERY token of
# that command is re-tokenised and added to the set, recursively and
# unconditionally — the interpreter test gates the TOP level only.
#
# Not "the argument of -c". That shape was narrowed wrong twice (`bash -lc`,
# `bash -e -u -c`, `bash -c -- …`, `bash <<< …`, `echo … | bash` all evaded
# it), and enumerating calling conventions is a losing game.
#
# LIMITS, stated plainly rather than implied: SHELLS is a NAME LIST, so an
# interpreter not on it (say `busybox`, or a wrapper script) is not expanded.
# Widen the list when one turns up; do not read this as "all execution is
# covered".
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

# Anything that takes a string and RUNS it — not only shells. `ssh host "<a
# merge>"` and `python3 -c "os.system(...)"` execute their argument exactly as
# surely as `bash -c` does, and each was a hole while this set said "shells".
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "eval", "ssh",
          "perl", "python", "python3", "ruby", "node", "xargs"}
DEPTH = 6

def split(raw):
    # Explicit punctuation set, NOT True: shlex default omits the backtick, so
    # it stayed glued to the command word and exact-token matching missed it.
    # Command substitution with $() was caught while the backtick form was not
    # — an arbitrary split rather than a principled boundary.
    lex = shlex.shlex(raw, posix=True, punctuation_chars="();<>|&" + chr(96))
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
    # The interpreter test gates the TOP level only. Once a line is known to
    # run one, every level below it expands unconditionally — the payload is
    # usually wrapped in a layer that mentions no interpreter of its own
    # (perl -e "system(<a merge>)" nests it inside a call), and re-testing per
    # level stopped the recursion exactly one layer short of the command.
    if depth == 0 and not any(os.path.basename(t) in SHELLS for t in toks):
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

# :-/tmp so an unset HOME cannot trip `set -u` here — losing the audit trail is
# survivable, aborting the gate is not.
AUDIT="${HOME:-/tmp}/.agentkit/review-audit.log"

deny() {
	mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
	printf '%s\tDENY\tsession=%s\t%s\n' "$(date -Is)" "$SESSION" "${1//$'\n'/ }" >>"$AUDIT" 2>/dev/null || true
	agentkit_deny_json "$1"
	exit 0
}

# --- MCP merge tools: no Bash to inspect, so refuse outright ---------------
# These bypass every command-shaped check. The CLI path is the reviewed path.
if [[ -n "$TOOL" && "$TOOL_FAMILY" != "Bash" ]]; then
	if echo "$TOOL" | grep -qiE 'merge_(pull_request|request)|pull_request_merge|mr_merge'; then
		deny "BLOCKED: merging through an MCP tool bypasses the review gate.

Use the CLI (\`glab mr merge\` / \`gh pr merge\`) so the merge is checked against
the review record for the commit being merged."
	fi
	exit 0
fi

[[ -z "$COMMAND" ]] && exit 0

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
# The merge path IS the attempt, whatever calls it: any caller allowlist leaves
# python, node, ruby and every wrapper script outside it. Reading such a URL
# therefore denies too — a false deny is the cheaper failure here.
if tok_match 'merge_requests?(/|%2f)[0-9]+(/|%2f)merge|/pulls/[0-9]+/merge'; then is_merge=1; fi
# GraphQL reaches the same act by name rather than by path, so no URL shape
# appears at all. These are the merge mutations either forge exposes.
if tok_match 'mergeRequestAccept|mergePullRequest'; then is_merge=1; fi
# Split-variable form: the URL is assembled at runtime. What separates that from
# prose is not an interpolation — `$(…)`, backticks, `$1` and a string built
# inside an interpreter all lack one — but ADJACENCY: an assembled path has
# something joined to /merge, while English puts a space before it.
if echo "$RAW_COMMAND" | grep -qiE 'merge_requests?|/pulls?/' &&
	echo "$RAW_COMMAND" | grep -qE '[^[:space:]]/merge\b'; then is_merge=1; fi
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
		local details repo_json repository repository_id host target_branch encoded_target target_json repo_name
		details=$(gh pr view "$MR_ID" ${REPO_FLAG:+--repo "$REPO_FLAG"} \
			--json headRefName,headRefOid,baseRefName,baseRefOid 2>/dev/null) || return 1
		if [[ -n "$REPO_FLAG" ]]; then
			repo_json=$(gh repo view "$REPO_FLAG" --json id,url,nameWithOwner 2>/dev/null) || return 1
		else
			repo_json=$(gh repo view --json id,url,nameWithOwner 2>/dev/null) || return 1
		fi
		repository=$(jq -r '.url // empty' <<<"$repo_json")
		host=$(jq -r '.url // empty | capture("^https?://(?<host>[^/]+)").host // empty' <<<"$repo_json")
		repository_id=$(jq -r --arg host "$host" '"github:\($host):\(.id // empty)"' <<<"$repo_json")
		repo_name=$(jq -r '.nameWithOwner // empty' <<<"$repo_json")
		target_branch=$(jq -r '.baseRefName // empty' <<<"$details")
		[[ -n "$repository" && -n "$repository_id" && -n "$host" && -n "$repo_name" && -n "$target_branch" ]] || return 1
		encoded_target=$(printf '%s' "$target_branch" | jq -sRr @uri)
		target_json=$(gh api --hostname "$host" "repos/$repo_name/branches/$encoded_target" 2>/dev/null) || return 1
		jq -cn --argjson details "$details" --argjson target "$target_json" \
			--arg repository "$repository" --arg repository_id "$repository_id" '{
          forge: "github",
          repository: $repository,
          repository_id: $repository_id,
          source_branch: $details.headRefName,
          source_sha: $details.headRefOid,
          target_branch: $details.baseRefName,
          target_sha: $target.commit.sha
        }'
	else
		local details target_branch target_project encoded_target target_json repository repository_id host
		details=$(glab mr view "$MR_ID" ${REPO_FLAG:+--repo "$REPO_FLAG"} --output json 2>/dev/null) || return 1
		target_branch=$(jq -r '.target_branch // empty' <<<"$details")
		target_project=$(jq -r '.target_project_id // .project_id // empty' <<<"$details")
		host=$(jq -r '.web_url // empty | capture("^https?://(?<host>[^/]+)").host // empty' <<<"$details")
		repository=$(jq -r '.web_url // empty | sub("/-/merge_requests/[0-9]+$"; "")' <<<"$details")
		[[ -n "$target_branch" && -n "$target_project" && -n "$host" && -n "$repository" ]] || return 1
		encoded_target=$(printf '%s' "$target_branch" | jq -sRr @uri)
		target_json=$(glab api --hostname "$host" \
			"projects/$target_project/repository/branches/$encoded_target" 2>/dev/null) || return 1
		repository_id="gitlab:$host:$target_project"
		jq -cn --argjson details "$details" --argjson target "$target_json" \
			--arg repository "$repository" --arg repository_id "$repository_id" '{
          forge: "gitlab",
          repository: $repository,
          repository_id: $repository_id,
          source_branch: $details.source_branch,
          source_sha: ($details.sha // $details.diff_refs.head_sha),
          target_branch: $details.target_branch,
          target_sha: $target.commit.id
        }'
	fi
}

BRANCH=""
HEAD_SHA=""
TARGET_BRANCH=""
TARGET_SHA=""
FORGE=""
REPOSITORY=""
REPOSITORY_ID=""
SHA_PATTERN='^[0-9a-f]{40}([0-9a-f]{24})?$'
if [[ -n "$MR_ID" ]]; then
	RESOLVED=$(cd "$REPO_DIR" 2>/dev/null && forge_json || true)
	BRANCH=$(jq -r '.source_branch // empty' <<<"$RESOLVED" 2>/dev/null || true)
	HEAD_SHA=$(jq -r '.source_sha // empty' <<<"$RESOLVED" 2>/dev/null || true)
	TARGET_BRANCH=$(jq -r '.target_branch // empty' <<<"$RESOLVED" 2>/dev/null || true)
	TARGET_SHA=$(jq -r '.target_sha // empty' <<<"$RESOLVED" 2>/dev/null || true)
	FORGE=$(jq -r '.forge // empty' <<<"$RESOLVED" 2>/dev/null || true)
	REPOSITORY=$(jq -r '.repository // empty' <<<"$RESOLVED" 2>/dev/null || true)
	REPOSITORY_ID=$(jq -r '.repository_id // empty' <<<"$RESOLVED" 2>/dev/null || true)
fi

if [[ -z "$BRANCH" || -z "$HEAD_SHA" || -z "$TARGET_BRANCH" || -z "$TARGET_SHA" ||
	-z "$FORGE" || -z "$REPOSITORY" || -z "$REPOSITORY_ID" ||
	! "$HEAD_SHA" =~ $SHA_PATTERN ||
	! "$TARGET_SHA" =~ $SHA_PATTERN ]]; then
	deny "BLOCKED: cannot resolve what this merge would land, so it cannot be gated.

  command dir: $REPO_DIR
  mr/pr id:    ${MR_ID:-<none found>}

The gate must read the change's source/target branches and exact SHAs from the
forge — the local checkout alone says nothing about the commit being merged.
Run the merge from the repo directory with an explicit MR/PR number and an
authenticated forge CLI."
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

# --- Strict evidence policy -------------------------------------------------
# Policy is read from the exact TARGET commit. Reading the source checkout here
# would let a change weaken the rules that judge that same change. A target with
# no policy is the explicit bootstrap boundary and retains the legacy v1 record.
ensure_commit() {
	local sha="$1"
	local forge_ref="$2"
	if git -C "$REPO_DIR" cat-file -e "$sha^{commit}" 2>/dev/null; then
		return 0
	fi
	git -C "$REPO_DIR" fetch --quiet origin "$forge_ref" 2>/dev/null || true
	if git -C "$REPO_DIR" cat-file -e "$sha^{commit}" 2>/dev/null; then
		return 0
	fi
	git -C "$REPO_DIR" fetch --quiet origin "$sha" 2>/dev/null || true
	git -C "$REPO_DIR" cat-file -e "$sha^{commit}" 2>/dev/null
}

TARGET_REF="refs/heads/$TARGET_BRANCH"
if ! ensure_commit "$TARGET_SHA" "$TARGET_REF"; then
	deny "BLOCKED: the forge target commit cannot be read locally, so target policy cannot be resolved.

  target branch: $TARGET_BRANCH
  target sha:    $TARGET_SHA

The gate will not interpret an unavailable target policy as an absent policy."
fi

POLICY_PATH='.agentkit/review-policy.json'
if ! POLICY_ENTRY=$(git -C "$REPO_DIR" ls-tree "$TARGET_SHA" -- "$POLICY_PATH" 2>/dev/null); then
	deny 'BLOCKED: the exact target commit cannot be inspected for review policy.'
fi
if [[ -n "$POLICY_ENTRY" ]]; then
	read -r POLICY_MODE POLICY_TYPE POLICY_BLOB POLICY_NAME <<<"$POLICY_ENTRY"
	if [[ "$POLICY_TYPE" != "blob" ||
		( "$POLICY_MODE" != "100644" && "$POLICY_MODE" != "100755" ) ||
		"$POLICY_NAME" != "$POLICY_PATH" ]]; then
		deny 'BLOCKED: target policy must be one regular file at .agentkit/review-policy.json.'
	fi
	POLICY_TMP=$(mktemp "${TMPDIR:-/tmp}/agentkit-review-policy.XXXXXX") || \
		deny 'BLOCKED: cannot allocate a temporary file for target policy validation.'
	PATHS_TMP=$(mktemp "${TMPDIR:-/tmp}/agentkit-review-paths.XXXXXX") || {
		rm -f "$POLICY_TMP"
		deny 'BLOCKED: cannot allocate a temporary file for changed-path validation.'
	}
	cleanup_review_gate_files() {
		rm -f "$POLICY_TMP" "$PATHS_TMP"
	}
	trap cleanup_review_gate_files EXIT

	if ! git -C "$REPO_DIR" show "$TARGET_SHA:$POLICY_PATH" >"$POLICY_TMP" 2>/dev/null; then
		deny 'BLOCKED: target policy exists but its exact bytes could not be read.'
	fi
	if ! jq -e . "$POLICY_TMP" >/dev/null 2>&1; then
		deny 'BLOCKED: target policy is malformed JSON and strict review cannot run.'
	fi

	SOURCE_REF="refs/merge-requests/$MR_ID/head"
	[[ "$FORGE" == "github" ]] && SOURCE_REF="refs/pull/$MR_ID/head"
	if ! ensure_commit "$HEAD_SHA" "$SOURCE_REF"; then
		deny "BLOCKED: the exact source commit cannot be read locally, so changed paths cannot be enumerated.

  source branch: $BRANCH
  source sha:    $HEAD_SHA"
	fi

	MERGE_BASE=$(git -C "$REPO_DIR" merge-base "$TARGET_SHA" "$HEAD_SHA" 2>/dev/null || true)
	if [[ -z "$MERGE_BASE" ]]; then
		deny 'BLOCKED: no merge base can be computed for the exact source and target commits.'
	fi
	if ! git -C "$REPO_DIR" diff --name-only -z --no-renames "$MERGE_BASE" "$HEAD_SHA" 2>/dev/null |
		jq -Rs 'split("\u0000") | map(select(length > 0)) | unique' >"$PATHS_TMP"; then
		deny 'BLOCKED: changed paths could not be mechanically enumerated from the exact commits.'
	fi

	HOOK_DIR="${BASH_SOURCE[0]%/*}"
	REVIEW_GATE=""
	for candidate in "$HOOK_DIR/../tools/review-gate" "$HOOK_DIR/../../tools/review-gate"; do
		if [[ -x "$candidate" ]]; then
			REVIEW_GATE="$candidate"
			break
		fi
	done
	if [[ -z "$REVIEW_GATE" ]]; then
		deny 'BLOCKED: strict target policy is active but the packaged review-gate validator is unavailable.'
	fi

	if GATE_OUTPUT=$("$REVIEW_GATE" \
		--record "$RECORD" \
		--policy "$POLICY_TMP" \
		--changed-paths "$PATHS_TMP" \
		--forge "$FORGE" \
		--repository "$REPOSITORY" \
		--repository-id "$REPOSITORY_ID" \
		--change-id "$MR_ID" \
		--source-branch "$BRANCH" \
		--target-branch "$TARGET_BRANCH" \
		--source-sha "$HEAD_SHA" \
		--target-sha "$TARGET_SHA" 2>&1); then
		case "$GATE_OUTPUT" in
		PASS:*) ;;
		CONSENT_OVERRIDE:*)
			CONSENT_QUOTE=$(jq -r '.user_consent.quote // empty' "$RECORD")
			mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
			printf '%s\tCONSENT-OVERRIDE\tsession=%s\tbranch=%s\tsha=%s\tquote=%s\n' \
				"$(date -Is)" "$SESSION" "$BRANCH" "$HEAD_SHA" "${CONSENT_QUOTE//$'\n'/ }" \
				>>"$AUDIT" 2>/dev/null || true
			exit 0
			;;
		*) deny "BLOCKED: review-gate returned an unusable success response: ${GATE_OUTPUT:-<empty>}" ;;
		esac
	else
		deny "${GATE_OUTPUT:-BLOCKED: review-gate failed without a reason.}"
	fi

	mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
	printf '%s\tPASS-STRICT\tsession=%s\tbranch=%s\tsha=%s\ttarget=%s\n' \
		"$(date -Is)" "$SESSION" "$BRANCH" "$HEAD_SHA" "$TARGET_SHA" \
		>>"$AUDIT" 2>/dev/null || true
	exit 0
fi

# No policy at the exact target commit: bounded bootstrap compatibility for
# repositories that have not activated strict v2 yet. A source-added policy
# begins governing only after it lands on the protected target.

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
