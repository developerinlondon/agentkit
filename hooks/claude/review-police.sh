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
SECONDS=0

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
# shellcheck disable=SC2016 # Python source is intentionally single-quoted shell data.
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

audit_timestamp() {
	date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '%s' 'timestamp-unavailable'
}

deny() {
	mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
	printf '%s\tDENY\tsession=%s\t%s\tgate_seconds=%s\n' "$(audit_timestamp)" "$SESSION" "${1//$'\n'/ }" "$SECONDS" >>"$AUDIT" 2>/dev/null || true
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
# Match a command name by basename too: an absolute `.../glab` reaches the same
# forge as `glab` and must not evade a name-only detector.
has_basename() {
	printf '%s' "$COMMAND" | awk -v wanted="$1" '
		{
			n = split($0, parts, "/")
			if (parts[n] == wanted) found = 1
		}
		END { exit(found ? 0 : 1) }
	'
}
# Any token matching a regex (URLs keep their value through tokenisation).
tok_match() { printf '%s' "$COMMAND" | grep -qiE -- "$1"; }

# `gh api graphql` can take its request body from a file or stdin. The mutation
# name then never appears in RAW_COMMAND/COMMAND, and inspecting the current
# file bytes is not enough: the same shell call or another process can replace
# them before the CLI reads them. Deny every indirect GraphQL body. Inline
# read-only queries remain available because their immutable text is in the
# command the hook actually checks.
graphql_payload_indirect=0

raw_has_active_shell_expansion() {
	local status=0
	if ! command -v python3 >/dev/null 2>&1; then
		[[ "$RAW_COMMAND" == *'$'* || "$RAW_COMMAND" == *'`'* ]]
		return
	fi

	if printf '%s' "$RAW_COMMAND" | python3 -c '
import sys

raw = sys.stdin.read()
single = False
double = False
escaped = False
for char in raw:
    if escaped:
        escaped = False
        continue
    if char == chr(92) and not single:
        escaped = True
        continue
    if char == chr(39) and not double:
        single = not single
        continue
    if char == chr(34) and not single:
        double = not double
        continue
    if not single and char in (chr(36), chr(96)):
        raise SystemExit(0)
raise SystemExit(2 if single or double or escaped else 1)
'; then
		return 0
	else
		status=$?
	fi
	[[ $status -eq 1 ]] && return 1
	# Parser errors and incomplete shell quoting are opaque, so fail closed.
	return 0
}

scan_graphql_payload_refs() {
	local token=""
	local expect_input=0
	local expect_field=0

	while IFS= read -r token; do
		if [[ $expect_input -eq 1 ]]; then
			graphql_payload_indirect=1
			expect_input=0
			continue
		fi
		if [[ $expect_field -eq 1 ]]; then
			if [[ "$token" == query=@* ]]; then
				graphql_payload_indirect=1
			fi
			expect_field=0
			continue
		fi

		case "$token" in
		--input)
			expect_input=1
			;;
		--input=*)
			graphql_payload_indirect=1
			;;
		-F | --field)
			expect_field=1
			;;
		-Fquery=@*)
			graphql_payload_indirect=1
			;;
		-F=query=@*)
			graphql_payload_indirect=1
			;;
		--field=query=@*)
			graphql_payload_indirect=1
			;;
		esac
	done <<<"$COMMAND"

	if [[ $expect_input -eq 1 ]]; then
		graphql_payload_indirect=1
	fi
}

# --- Is this a merge attempt? ---------------------------------------------
# Subcommands are separate tokens, so flags and their arguments no longer need
# tolerating in a regex — `glab -R o/r mr merge` and `glab mr --repo o/r merge`
# both simply contain the tokens glab, mr, merge.
# NOTE: every match below is wrapped so a NON-match cannot abort the script.
# `grep -q … && is_merge=1` returns non-zero when the pattern misses, and under
# `set -e` that exits the hook silently — i.e. FAILS OPEN, allowing the merge.
is_merge=0
direct_api_merge=0
# Do not require a literal `glab` / `gh` token here. Shell variables can build
# the executable name (`A=g; B=lab; "$A$B" mr merge 12`) while leaving the
# subcommand tokens intact. Classify the merge shape first; the standalone
# parser below then rejects anything except one literal forge invocation.
if has mr && has merge; then is_merge=1; fi
if has mr && has accept; then is_merge=1; fi
if has pr && has merge; then is_merge=1; fi
# A variable can replace the group token too (`part=mr; glab "$part" merge`).
# Any dynamically assembled command that exposes the merge verb either as a
# literal token or an exact variable assignment is not safely classifiable as
# ordinary work. Route it to the strict parser; that parser rejects
# interpolation rather than letting this path fall silent.
if echo "$RAW_COMMAND" | grep -q '\$'; then
	if has merge || tok_match '^[[:alpha:]_][[:alnum:]_]*=merge$'; then is_merge=1; fi
fi
# The merge path IS the attempt, whatever calls it: any caller allowlist leaves
# python, node, ruby and every wrapper script outside it. Reading such a URL
# therefore denies too — a false deny is the cheaper failure here.
if tok_match 'merge_requests?(/|%2f)[0-9]+(/|%2f)merge|/pulls/[0-9]+/merge'; then
	is_merge=1
	direct_api_merge=1
fi
# GraphQL reaches the same act by name rather than by path, so no URL shape
# appears at all. These are the merge mutations either forge exposes.
if tok_match 'mergeRequestAccept|mergePullRequest'; then
	is_merge=1
	direct_api_merge=1
fi
# File/stdin-backed GraphQL requests are mutable after the hook checks them.
# The endpoint can be indirect too (`endpoint=graphql; gh api "$endpoint"`), so
# a forge API call with an indirect body and a shell-built endpoint must be
# treated as GraphQL-shaped even when no standalone `graphql` token survives.
# Keep ordinary inline queries allowed, but fail closed on every indirect body.
graphql_api=0
forge_api=0
graphql_shell_indirect=0
if has api; then
	if has_basename gh || has_basename glab; then forge_api=1; fi
fi
if [[ $forge_api -eq 1 ]]; then
	if raw_has_active_shell_expansion; then graphql_shell_indirect=1; fi
	if tok_match '(^|[=/])graphql([?#].*)?$' || [[ $graphql_shell_indirect -eq 1 ]]; then
		graphql_api=1
	fi
fi
if [[ $graphql_api -eq 1 ]]; then
	scan_graphql_payload_refs
	if [[ $graphql_shell_indirect -eq 1 ]]; then graphql_payload_indirect=1; fi
	if [[ $graphql_payload_indirect -eq 1 ]]; then
		deny "BLOCKED: an indirect GraphQL API payload can change after this check and may hide a merge mutation.

Use an inline read-only query whose complete text is visible in this command.
Use 'gh pr merge' / 'glab mr merge' for merges so review evidence is checked."
	fi
fi
# Split-variable form: the URL is assembled at runtime. What separates that from
# prose is not an interpolation — `$(…)`, backticks, `$1` and a string built
# inside an interpreter all lack one — but ADJACENCY: an assembled path has
# something joined to /merge, while English puts a space before it.
if echo "$RAW_COMMAND" | grep -qiE 'merge_requests?|/pulls?/' &&
	echo "$RAW_COMMAND" | grep -qE '[^[:space:]]/merge\b'; then
	is_merge=1
	direct_api_merge=1
fi
# The final path component can itself be a variable. Keep this deliberately
# conservative: a pull/MR endpoint, a variable whose exact assigned value is
# `merge`, and a variable interpolation immediately after `/` together form a
# merge-shaped endpoint even though the literal `/merge` never appears.
if echo "$RAW_COMMAND" | grep -qiE 'merge_requests?|/pulls?/' &&
	tok_match '^[[:alpha:]_][[:alnum:]_]*=merge$' &&
	tok_match '/\$\{?[[:alpha:]_]'; then
	is_merge=1
	direct_api_merge=1
fi
# Gate on an actual `git push` — `-o` is ubiquitous (grep -o, curl -o, cc -o),
# so matching it bare denied commands that merely MENTIONED the pattern,
# including grepping for the rule this hook enforces. As tokens: the option's
# value is the token after `-o`, or is fused into `--push-option=…`.
# Scan EVERY option, not just the first: `git push -o ci.skip -o
# merge_request.merge_when_pipeline_succeeds` is the idiomatic multi-option
# form, and reading only the token after the first `-o` let it through.
# A push-option value counts when its PREDECESSOR token is -o/--push-option
# (covering both the short and the space-separated long form), or when it is
# fused as --push-option=<value> or Git's valid -o<value> spelling.
push_option_merge() {
	printf '%s' "$COMMAND" | awk '
		/^--push-option=.*merge_request\.merge/ { found = 1 }
		/^-omerge_request\.merge/ { found = 1 }
		prev == "-o" || prev == "--push-option" {
			if ($0 ~ /^merge_request\.merge/) found = 1
		}
		{ prev = $0 }
		END { exit(found ? 0 : 1) }
	'
}
# The executable can itself be expanded from a variable. `push` plus the exact
# merge-option shape is specific enough to fail closed without a literal `git`;
# quoted commit-message prose remains one token and does not satisfy either arm.
if has push && push_option_merge; then
	deny "BLOCKED: a merge-on-pipeline push option queues a merge no review has seen.

Push the branch without the merge push-option, then merge explicitly so the
gate can check the commit that actually lands."
fi
[[ $is_merge -eq 1 ]] || exit 0

# A REST/GraphQL endpoint carries its own repository identity, which may differ
# from the current checkout. Resolving only its numeric change id through the
# checkout would let an approved local change authorise a same-numbered change
# elsewhere. Refuse the unbindable form; the typed forge CLI supplies repository
# context that forge_json can resolve and compare with the evidence record.
if [[ $direct_api_merge -eq 1 ]]; then
	deny "BLOCKED: a direct REST merge or GraphQL merge mutation cannot be bound to the reviewed repository context.

Use 'gh pr merge' or 'glab mr merge' with an explicit repository when needed so
the gate can resolve and verify the exact change before it lands."
fi

# PreToolUse observes the whole Bash tool call only once. If that call can run
# anything around the merge, the checked head may no longer be the head that
# lands (`git push B && glab mr merge 12`), or a second change may merge after
# the first record is accepted. Permit only one literal, top-level forge CLI
# invocation. This parser is also the single source of CLI, change ID, and
# repository selector; re-scanning the flattened token set would reintroduce
# disagreement over which change the actual CLI targets.
parse_standalone_forge_merge() {
	printf '%s' "$RAW_COMMAND" | python3 -c '
import json, re, shlex, sys

raw = sys.stdin.read()
if "\n" in raw or "$" in raw or chr(96) in raw:
    raise SystemExit(1)

try:
    lex = shlex.shlex(raw, posix=True, punctuation_chars="();<>|&" + chr(96))
    lex.whitespace_split = True
    lex.commenters = "#"
    tokens = list(lex)
except ValueError:
    raise SystemExit(1)

if len(tokens) < 4:
    raise SystemExit(1)
if any(token and all(char in "();<>|&" + chr(96) for char in token) for token in tokens):
    raise SystemExit(1)
if any(any(char in token for char in "*?[]{}") for token in tokens):
    raise SystemExit(1)

tool = tokens[0]
expected_group = "pr" if tool == "gh" else "mr" if tool == "glab" else ""
if tokens[:3] != [tool, expected_group, "merge"] or not tokens[3].isdigit():
    raise SystemExit(1)
if tokens.count("merge") != 1:
    raise SystemExit(1)

repo = ""
selectors = 0
expected_head = ""
head_guards = 0
head_flag = "--match-head-commit" if tool == "gh" else "--sha"
i = 4
while i < len(tokens):
    token = tokens[i]
    if token in {"-R", "--repo"}:
        i += 1
        if i >= len(tokens) or not tokens[i] or tokens[i].startswith("-"):
            raise SystemExit(1)
        selectors += 1
        repo = tokens[i]
    elif token.startswith("--repo="):
        value = token[len("--repo="):]
        if not value:
            raise SystemExit(1)
        selectors += 1
        repo = value
    elif token == head_flag:
        i += 1
        if i >= len(tokens):
            raise SystemExit(1)
        head_guards += 1
        expected_head = tokens[i].lower()
    elif token.startswith(head_flag + "="):
        head_guards += 1
        expected_head = token[len(head_flag) + 1:].lower()
    elif token.startswith("-R") or token.startswith("--repo") or token.startswith("--host"):
        raise SystemExit(1)
    i += 1

if selectors > 1 or head_guards > 1:
    raise SystemExit(1)
if expected_head and not re.fullmatch("[0-9a-f]{40}([0-9a-f]{24})?", expected_head):
    raise SystemExit(1)
print(json.dumps({
    "cli": tool,
    "change_id": int(tokens[3]),
    "repository": repo,
    "expected_head": expected_head,
}))
' 2>/dev/null
}
if ! CLI_CONTEXT=$(parse_standalone_forge_merge); then
	deny "BLOCKED: a reviewed merge must be one standalone forge CLI command.

Do not wrap or combine it with pushes, command substitutions, other merges, or
other shell commands. Use the literal form 'gh pr merge <id>' or 'glab mr merge
<id>', with any flags after the numeric ID, so the head checked by the gate is
the head that lands."
fi
CLI=$(jq -r '.cli // empty' <<<"$CLI_CONTEXT" 2>/dev/null || true)
MR_ID=$(jq -r '.change_id // empty' <<<"$CLI_CONTEXT" 2>/dev/null || true)
REPO_FLAG=$(jq -r '.repository // empty' <<<"$CLI_CONTEXT" 2>/dev/null || true)
EXPECTED_HEAD=$(jq -r '.expected_head // empty' <<<"$CLI_CONTEXT" 2>/dev/null || true)
if [[ ( "$CLI" != "gh" && "$CLI" != "glab" ) || ! "$MR_ID" =~ ^[0-9]+$ ]]; then
	deny 'BLOCKED: the standalone merge command could not be bound to one literal change ID.'
fi

# Auto-merge queues the merge for a LATER head — the sha we check now is not
# the sha that lands. Refuse the mode rather than pretend to gate it.
if tok_match '^--(auto(=.*)?|auto-merge(=true)?|merge-when-pipeline-succeeds|when-pipeline-succeeds)$'; then
	deny "BLOCKED: auto-merge cannot be review-gated.

It merges a future head that no review has seen. Wait for the pipeline, then
merge explicitly so the gate can check the commit that actually lands."
fi
if [[ "$CLI" == "glab" ]] && ! tok_match '^--auto-merge=false$'; then
	deny "BLOCKED: current glab defaults to auto-merge while a pipeline is running.

Add '--auto-merge=false' so this command attempts an immediate merge. Deferred
auto-merge can land a later head that no review has seen."
fi

# --- Resolve WHAT is being merged, from the forge ---------------------------
# Fail CLOSED: if the target cannot be resolved, the gate denies. An
# unresolvable merge is exactly when a mistake is most likely.
REQUEST_WORKDIR=$(agentkit_workdir)
SEARCH_DIR=${REQUEST_WORKDIR:-$PWD}
if [[ "$SEARCH_DIR" != /* ]]; then
	deny "BLOCKED: the merge tool working directory must be an absolute path.

  tool working directory: $SEARCH_DIR"
fi
if [[ ! -d "$SEARCH_DIR" ]]; then
	deny "BLOCKED: the merge tool working directory is not a readable directory.

  tool working directory: $SEARCH_DIR"
fi

REPO_DIR=""
if REPO_ROOT=$(git -C "$SEARCH_DIR" rev-parse --show-toplevel 2>/dev/null) && [[ -n "$REPO_ROOT" ]]; then
	REPO_DIR="$REPO_ROOT"
elif [[ -z "$REPO_FLAG" ]]; then
	deny "BLOCKED: the merge tool working directory is not a Git worktree and the command has no explicit repository.

  tool working directory: $SEARCH_DIR

The review record and target policy must be resolved from the repository that
the forge change will land in. Add an explicit --repo owner/name selector, or
run the agent from the repository itself."
fi

forge_json() {
	if [[ "$CLI" == "gh" ]]; then
		local details repo_json repository repository_id host target_branch encoded_target target_json repo_name
		local rules_json merge_queue
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
		rules_json=$(gh api --hostname "$host" --paginate --slurp \
			"repos/$repo_name/rules/branches/$encoded_target?per_page=100" 2>/dev/null) || return 1
		merge_queue=$(jq -r '
          if type == "array" and all(.[]; type == "array") then
            any(.[][]; .type == "merge_queue")
          else
            error("malformed branch rules")
          end
        ' <<<"$rules_json") || return 1
		jq -cn --argjson details "$details" --argjson target "$target_json" \
			--argjson merge_queue "$merge_queue" \
			--arg repository "$repository" --arg repository_id "$repository_id" '{
          forge: "github",
          repository: $repository,
          repository_id: $repository_id,
          source_branch: $details.headRefName,
          source_sha: $details.headRefOid,
          target_branch: $details.baseRefName,
          target_sha: $target.commit.sha,
          merge_queue: $merge_queue
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
          target_sha: $target.commit.id,
          merge_queue: false
        }'
	fi
}

canonical_repository_url() {
	# shellcheck disable=SC2016 # Python source is intentionally single-quoted shell data.
	python3 -c '
import re, sys
from urllib.parse import urlsplit

raw = sys.stdin.read().strip()
if not raw:
    raise SystemExit(1)

scheme = "ssh"
port = None
if "://" not in raw:
    match = re.match(r"^(?:[^@/]+@)?([^:/]+):(.+)$", raw)
    if not match:
        raise SystemExit(1)
    host, path = match.groups()
else:
    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    host, path = parsed.hostname or "", parsed.path
    try:
        port = parsed.port
    except ValueError:
        raise SystemExit(1)

path = path.strip("/")
if path.endswith(".git"):
    path = path[:-4]
if not host or not path:
    raise SystemExit(1)

host = host.lower()
if ":" in host:
    host = f"[{host}]"
default_ports = {"http": 80, "https": 443, "ssh": 22, "git": 9418}
if port is not None and port != default_ports.get(scheme):
    host = f"{host}:{port}"
print(f"{host}/{path}")
'
}

repo_matches_repository() {
	local repo_root="$1"
	local expected="$2"
	local remotes remote url actual

	remotes=$(git -C "$repo_root" remote 2>/dev/null || true)
	while IFS= read -r remote; do
		[[ -n "$remote" ]] || continue
		while IFS= read -r url; do
			if actual=$(printf '%s' "$url" | canonical_repository_url 2>/dev/null) &&
				[[ "$actual" == "$expected" ]]; then
				return 0
			fi
		done < <(git -C "$repo_root" remote get-url --all "$remote" 2>/dev/null || true)
	done <<<"$remotes"
	return 1
}

discover_review_repo() {
	local search_root="$1"
	local slug="$2"
	local repository="$3"
	local expected record reviews_dir agentkit_dir candidate repo_root candidate_real root_real
	local -a matches=()

	expected=$(printf '%s' "$repository" | canonical_repository_url 2>/dev/null) || return 1
	while IFS= read -r -d '' record; do
		[[ "${record##*/}" == "$slug.json" ]] || continue
		reviews_dir=${record%/*}
		[[ "${reviews_dir##*/}" == "reviews" ]] || continue
		agentkit_dir=${reviews_dir%/*}
		[[ "${agentkit_dir##*/}" == ".agentkit" ]] || continue
		candidate=${agentkit_dir%/*}
		repo_root=$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null) || continue
		candidate_real=$(cd "$candidate" 2>/dev/null && pwd -P) || continue
		root_real=$(cd "$repo_root" 2>/dev/null && pwd -P) || continue
		[[ "$candidate_real" == "$root_real" ]] || continue
		if repo_matches_repository "$root_real" "$expected"; then
			matches+=("$root_real")
		fi
	done < <(find "$search_root" \
		-type d \( -name .git -o -name node_modules -o -name target -o -name .cache \
		-o -name .moon -o -name .turbo -o -name .next -o -name dist -o -name build \
		-o -name vendor -o -name .venv -o -name venv -o -name .kube -o -name lost+found \) \
		-prune -o -type f -name '*.json' -path '*/.agentkit/reviews/*' -print0 2>/dev/null)

	[[ ${#matches[@]} -eq 1 ]] || return 1
	printf '%s\n' "${matches[0]}"
}

BRANCH=""
HEAD_SHA=""
TARGET_BRANCH=""
TARGET_SHA=""
FORGE=""
REPOSITORY=""
REPOSITORY_ID=""
MERGE_QUEUE=""
SHA_PATTERN='^[0-9a-f]{40}([0-9a-f]{24})?$'
if [[ -n "$MR_ID" ]]; then
	FORGE_RESOLVE_DIR=${REPO_DIR:-$SEARCH_DIR}
	RESOLVED=$(cd "$FORGE_RESOLVE_DIR" 2>/dev/null && forge_json || true)
	BRANCH=$(jq -r '.source_branch // empty' <<<"$RESOLVED" 2>/dev/null || true)
	HEAD_SHA=$(jq -r '.source_sha // empty' <<<"$RESOLVED" 2>/dev/null || true)
	TARGET_BRANCH=$(jq -r '.target_branch // empty' <<<"$RESOLVED" 2>/dev/null || true)
	TARGET_SHA=$(jq -r '.target_sha // empty' <<<"$RESOLVED" 2>/dev/null || true)
	FORGE=$(jq -r '.forge // empty' <<<"$RESOLVED" 2>/dev/null || true)
	REPOSITORY=$(jq -r '.repository // empty' <<<"$RESOLVED" 2>/dev/null || true)
	REPOSITORY_ID=$(jq -r '.repository_id // empty' <<<"$RESOLVED" 2>/dev/null || true)
	MERGE_QUEUE=$(jq -r 'if .merge_queue == true then "true" elif .merge_queue == false then "false" else empty end' \
		<<<"$RESOLVED" 2>/dev/null || true)
fi

if [[ -z "$BRANCH" || -z "$HEAD_SHA" || -z "$TARGET_BRANCH" || -z "$TARGET_SHA" ||
	-z "$FORGE" || -z "$REPOSITORY" || -z "$REPOSITORY_ID" || -z "$MERGE_QUEUE" ||
	! "$HEAD_SHA" =~ $SHA_PATTERN ||
	! "$TARGET_SHA" =~ $SHA_PATTERN ]]; then
	deny "BLOCKED: cannot resolve what this merge would land, so it cannot be gated.

  command dir: $SEARCH_DIR
  mr/pr id:    ${MR_ID:-<none found>}

The gate must read the change's source/target branches and exact SHAs from the
forge — the local checkout alone says nothing about the commit being merged.
Run the merge from the repo directory with an explicit MR/PR number and an
authenticated forge CLI."
fi

SLUG=${BRANCH//\//__}
if [[ -z "$REPO_DIR" ]]; then
	if ! REPO_DIR=$(discover_review_repo "$SEARCH_DIR" "$SLUG" "$REPOSITORY"); then
		deny "BLOCKED: the reviewed repository could not be resolved uniquely below the client working directory.

  client working directory: $SEARCH_DIR
  forge repository:         $REPOSITORY

Codex can expose its workspace directory instead of the nested command
directory. Keep exactly one local clone for this forge repository and branch
review record below that workspace, or run the agent from the repository."
	fi
fi

if [[ "$CLI" == "gh" && "$MERGE_QUEUE" == "true" ]]; then
	deny "BLOCKED: this target requires GitHub's merge queue, so the CLI merge is deferred.

The current gh client either enables auto-merge or adds the pull request to the
queue instead of completing this checked invocation. Use protected merge-queue
CI as the authoritative gate; this local evidence token cannot authorize a
deferred merge."
fi

# The hook and merge are two separate processes. The source may advance after
# this check but before the CLI reaches the forge. Make the forge itself enforce
# the reviewed SHA so that race becomes a refused merge, not an unreviewed one.
if [[ -z "$EXPECTED_HEAD" || "$EXPECTED_HEAD" != "$HEAD_SHA" ]]; then
	HEAD_FLAG='--sha'
	GROUP='mr'
	if [[ "$CLI" == "gh" ]]; then
		HEAD_FLAG='--match-head-commit'
		GROUP='pr'
	fi
	deny "BLOCKED: the merge command must carry the exact reviewed head precondition.

  resolved head: $HEAD_SHA
  command head:  ${EXPECTED_HEAD:-<missing>}

Retry '$CLI $GROUP merge $MR_ID' after adding '$HEAD_FLAG $HEAD_SHA'. The forge will
then refuse the merge if the source branch changes after this hook checks it."
fi

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
	read -r POLICY_MODE POLICY_TYPE _ POLICY_NAME <<<"$POLICY_ENTRY"
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
	# shellcheck disable=SC2329 # invoked by the EXIT trap below.
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
			printf '%s\tCONSENT-OVERRIDE\tsession=%s\tbranch=%s\tsha=%s\tquote=%s\tgate_seconds=%s\n' \
				"$(audit_timestamp)" "$SESSION" "$BRANCH" "$HEAD_SHA" "${CONSENT_QUOTE//$'\n'/ }" "$SECONDS" \
				>>"$AUDIT" 2>/dev/null || true
			exit 0
			;;
		*) deny "BLOCKED: review-gate returned an unusable success response: ${GATE_OUTPUT:-<empty>}" ;;
		esac
	else
		deny "${GATE_OUTPUT:-BLOCKED: review-gate failed without a reason.}"
	fi

	mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
	printf '%s\tPASS-STRICT\tsession=%s\tbranch=%s\tsha=%s\ttarget=%s\tgate_seconds=%s\n' \
		"$(audit_timestamp)" "$SESSION" "$BRANCH" "$HEAD_SHA" "$TARGET_SHA" "$SECONDS" \
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

VERDICT=$(jq -r '.verdict // "blocked" | ascii_downcase' "$RECORD" 2>/dev/null || echo blocked)
CONSENT=$(jq -r '.user_consent.granted // false' "$RECORD" 2>/dev/null || echo false)
CONSENT_QUOTE=$(jq -r '.user_consent.quote // empty' "$RECORD" 2>/dev/null || true)

if [[ -n "$BLOCKING" || "$VERDICT" != "pass" ]]; then
	if [[ "$CONSENT" == "true" && -n "$CONSENT_QUOTE" ]]; then
		mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
		printf '%s\tCONSENT-OVERRIDE\tsession=%s\tbranch=%s\tsha=%s\tquote=%s\tgate_seconds=%s\n' \
			"$(audit_timestamp)" "$SESSION" "$BRANCH" "$HEAD_SHA" "${CONSENT_QUOTE//$'\n'/ }" "$SECONDS" \
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
printf '%s\tPASS\tsession=%s\tbranch=%s\tsha=%s\tgate_seconds=%s\n' "$(audit_timestamp)" "$SESSION" "$BRANCH" "$HEAD_SHA" "$SECONDS" \
	>>"$AUDIT" 2>/dev/null || true
exit 0
