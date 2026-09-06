#!/usr/bin/env bash
# editor-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Several people can share one agent session, so a commit in a configured repo
# must name the person editing (an Edited-by trailer); the session answers once.
set -euo pipefail

AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"
RE_YAML_ITEM='^[[:space:]]*-[[:space:]]+(.*)'
RE_ENABLED='^enabled:[[:space:]]*(.*)$'
RE_FLOW_LIST='^repos:[[:space:]]*\[(.*)\][[:space:]]*$'

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input

# The gate needs jq to read its input and awk to read the command. Missing
# either, it refuses rather than exiting silently, because a hook that dies is
# read as allow. The deny is written by hand here: the helper itself needs jq.
for dep in jq awk; do
	command -v "$dep" >/dev/null 2>&1 && continue
	[[ "$AGENTKIT_RAW_INPUT" == *commit* ]] || exit 0
	reason="EDITOR GATE UNCHECKED (editor-police)\n$dep is not on PATH, so this command could not be checked for a commit in a repo whose commits must name the person editing. Install $dep (or fix PATH) and retry."
	printf '{"decision":"deny","reason":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason" "$reason"
	exit 0
done

COMMAND=$(agentkit_command)
[[ -z "$COMMAND" ]] && exit 0

if [[ -n "${AGENTKIT_SKIP_HOOKS:-}" ]]; then
	_skip=",$(printf '%s' "$AGENTKIT_SKIP_HOOKS" | tr -d '[:space:]'),"
	case "$_skip" in
	*",editor-police,"* | *",all,"*) exit 0 ;;
	esac
fi

# Cheap pre-filter on the raw text, with no pipe so a write error cannot decide
# the verdict; the tokeniser below decides what is a commit.
RE_COMMIT_WORD='(^|[^[:alnum:]_])commit([^[:alnum:]_]|$)'
[[ "$COMMAND" =~ $RE_COMMIT_WORD ]] || exit 0

ENABLED=true
REPOS=()
unquote() { local v="$1"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"; printf '%s' "$v"; }
strip_comment() { local v="$1"; v="${v%%#*}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }
add_repo() { local item; item="$(unquote "$(strip_comment "$1")")"; if [[ -n "$item" ]]; then REPOS+=("$item"); fi; }
load_config() {
	[[ -f "$AGENTKIT_CONFIG" ]] || return 0
	local in_section=false in_repos=false line trimmed item
	while IFS= read -r line || [[ -n "$line" ]]; do
		if [[ "$line" =~ ^[^[:space:]#] ]]; then
			in_section=false; in_repos=false
			[[ "$(strip_comment "$line")" == "editor-police:" ]] && in_section=true
			continue
		fi
		$in_section || continue
		trimmed="${line#"${line%%[![:space:]]*}"}"
		[[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
		if [[ "$trimmed" =~ $RE_ENABLED ]]; then
			ENABLED="$(unquote "$(strip_comment "${BASH_REMATCH[1]}")")"; in_repos=false; continue
		fi
		if [[ "$(strip_comment "$trimmed")" =~ $RE_FLOW_LIST ]]; then
			in_repos=false
			IFS=',' read -r -a flow <<<"${BASH_REMATCH[1]}"
			for item in "${flow[@]+"${flow[@]}"}"; do
				item="${item#"${item%%[![:space:]]*}"}"
				add_repo "$item"
			done
			continue
		fi
		if [[ "$trimmed" == "repos:"* ]]; then in_repos=true; continue; fi
		if [[ "$trimmed" =~ ^[a-z-]+: ]]; then in_repos=false; fi
		if $in_repos && [[ "$trimmed" =~ $RE_YAML_ITEM ]]; then
			add_repo "${BASH_REMATCH[1]}"
		fi
	done <"$AGENTKIT_CONFIG"
}
load_config
case "$(printf '%s' "$ENABLED" | tr '[:upper:]' '[:lower:]')" in false | no | off | 0) exit 0 ;; esac

# Which repo each commit targets is resolved from the command the way git-police
# does it, not pattern-matched over the raw text. One linear awk pass splits the
# command into simple segments on ; & && | || ( ) { } and unquoted newlines and
# tokenises each with shell quoting honoured and nothing expanded, so an
# unexpanded $(…) stays the literal text it is. Segments arrive \002-terminated
# with tokens \003-separated. A comment runs from an unquoted # at a token
# boundary to the end of its line. A substitution, `…` or $(…), opens a new
# segment even inside double quotes, since bash runs it. A heredoc body is data, not code: bash does not
# quote-parse it, so on << the delimiter is noted and the body lines are
# swallowed at the next unquoted newline. A segment still inside an open quote
# at the end is marked with a leading \005 and skipped, because bash refuses
# such a command outright.
glob_to_regex() { local g="$1"; g="${g//./\\.}"; g="${g//\*/[^/]+}"; printf '%s' "$g"; }

tokenize() {
	LC_ALL=C awk 'BEGIN { RS = "\001" }
	{
		s = $0; n = length(s); seg = ""; tok = ""; intok = 0; q = ""; nhd = 0; reopen = 0
		for (i = 1; i <= n; i++) {
			c = substr(s, i, 1)
			if (q == "" && c == "#" && !intok) {
				j = index(substr(s, i), "\n"); i = (j ? i + j - 2 : n); continue
			}
			if (q == "" && c == "<" && substr(s, i + 1, 1) == "<" && substr(s, i + 2, 1) == "<") {
				if (intok) { seg = seg tok "\003"; tok = ""; intok = 0 }
				i += 2; continue
			}
			if (q == "" && c == "<" && substr(s, i + 1, 1) == "<") {
				if (intok) { seg = seg tok "\003"; tok = ""; intok = 0 }
				i += 2; if (substr(s, i, 1) == "-") i++
				while (substr(s, i, 1) == " " || substr(s, i, 1) == "\t") i++
				d = ""
				while (i <= n) {
					c = substr(s, i, 1)
					if (c == " " || c == "\t" || c == "\n" || c == ";" || c == "|" || c == "&" || c == ")") break
					if (c != "\047" && c != "\"" && c != "\\") d = d c
					i++
				}
				hd[++nhd] = d; i--; continue
			}
			if (q == "" && c == "\n" && nhd > 0) {
				if (intok) { seg = seg tok "\003"; tok = ""; intok = 0 }
				printf "%s\002", seg; seg = ""
				for (h = 1; h <= nhd; h++) {
					while (i <= n) {
						j = index(substr(s, i + 1), "\n")
						line = (j ? substr(s, i + 1, j - 1) : substr(s, i + 1))
						i = (j ? i + j : n + 1)
						t = line; sub(/^\t+/, "", t)
						if (t == hd[h]) break
					}
				}
				nhd = 0; i--; continue
			}
			if (q != "") {
				if (c == q) { q = "" }
				else if (q == "\"" && (c == "`" || (c == "$" && substr(s, i + 1, 1) == "("))) {
					if (intok) { seg = seg tok "\003"; tok = ""; intok = 0 }
					printf "%s\002", seg; seg = ""; q = ""; reopen = 1
					if (c == "$") i++
				}
				else if (q == "\"" && c == "\\" && substr(s, i + 1, 1) == "\n") { i++ }
				else if (q == "\"" && c == "\\") { i++; tok = tok substr(s, i, 1) }
				else { tok = tok c }
				intok = 1; continue
			}
			if (c == "\047" || c == "\"") { q = c; intok = 1; continue }
			if (c == "\\" && substr(s, i + 1, 1) == "\n") { i++; continue }
			if (c == "\\") { i++; tok = tok substr(s, i, 1); intok = 1; continue }
			if (c == " " || c == "\t") { if (intok) { seg = seg tok "\003"; tok = ""; intok = 0 }; continue }
			if (c == ";" || c == "|" || c == "&" || c == "(" || c == ")" || c == "{" || c == "}" || c == "`" || c == "\n") {
				if (intok) { seg = seg tok "\003"; tok = ""; intok = 0 }
				printf "%s\002", seg; seg = ""
				if (reopen && (c == "`" || c == ")")) { q = "\""; reopen = 0; intok = 1; continue }
				d = substr(s, i + 1, 1)
				if ((c == "&" && d == "&") || (c == "|" && d == "|")) i++
				continue
			}
			tok = tok c; intok = 1
		}
		if (intok) seg = seg tok "\003"
		if (q != "") printf "\005%s\002", seg; else printf "%s\002", seg
	}'
}

abs_path() {
	local d="${1/#\~/$HOME}"
	[[ "$d" == /* ]] || d="$CWD/$d"
	if [[ -d "$d" ]]; then (cd "$d" 2>/dev/null && pwd -P) || printf '%s' "$d"; else printf '%s' "$d"; fi
}

# The index of the first token that is the command itself: shell keywords that
# share a segment with it (if, then, for, do, while, until, elif, else, !, {),
# wrappers, flags, VAR=value assignments and a numeric wrapper argument all
# come first. A GIT_DIR= assignment on the way names the repo.
skip_prefix() {
	local t; PREFIX_END=0
	while ((PREFIX_END < ${#TOKS[@]})); do
		t="${TOKS[PREFIX_END]}"
		case "$t" in
		GIT_DIR=*) GIT_DIR="${t#GIT_DIR=}"; GIT_DIR="${GIT_DIR%/.git}"; GIT_DIR="${GIT_DIR%/}" ;;
		if | then | elif | else | do | while | until | '!' | '{' | env | sudo | command | nice | time | nohup | timeout | bounded-run | -- | -* | *=* | [0-9]*) ;;
		*) break ;;
		esac
		PREFIX_END=$((PREFIX_END + 1))
	done
}

# Sets GIT_SUB and GIT_DIR from the segment's tokens when they run git,
# allowing the usual wrappers in front (env, sudo, VAR=value …). The dir is
# -C, --git-dir, or the tracked working directory.
parse_git() {
	GIT_SUB=""; GIT_DIR=""
	local i t expect=""
	skip_prefix; i=$PREFIX_END
	[[ "${TOKS[i]:-}" == git ]] || return 1
	for ((i = i + 1; i < ${#TOKS[@]}; i++)); do
		t="${TOKS[i]}"
		if [[ -n "$expect" ]]; then
			[[ "$expect" == dir ]] && GIT_DIR="$t"
			expect=""; continue
		fi
		case "$t" in
		-C) expect=dir ;;
		-C?*) GIT_DIR="${t#-C}" ;;
		-c | --work-tree | --namespace | --exec-path) expect=skip ;;
		--git-dir=*) GIT_DIR="${t#--git-dir=}"; GIT_DIR="${GIT_DIR%/.git}"; GIT_DIR="${GIT_DIR%/}" ;;
		--git-dir) expect=dir ;;
		-*) ;;
		*) GIT_SUB="$t"; break ;;
		esac
	done
	GIT_DIR="${GIT_DIR:-$CWD}"
	[[ -n "$GIT_SUB" ]]
}

# The repo a directory belongs to: its working tree, and for a linked
# worktree the main clone as well, so a worktree of a configured repo is judged
# like the clone.
repo_roots() {
	local d top common; d="$(abs_path "$1")"
	top="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" || { printf '%s\n' "$d"; return 0; }
	printf '%s\n' "$top"
	common="$(cd "$d" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null)" || return 0
	[[ "$common" == /* ]] || common="$(cd "$d" && cd "$common" 2>/dev/null && pwd -P)"
	common="${common%/.git}"
	[[ -n "$common" && "$common" != "$top" ]] && printf '%s\n' "$common"
	return 0
}

matches_repo() {
	local pattern re root
	while IFS= read -r root; do
		for pattern in "${REPOS[@]+"${REPOS[@]}"}"; do
			re="(^|/)$(glob_to_regex "$pattern")/"
			[[ "${root}/" =~ $re ]] && return 0
		done
	done <<<"$1"
	return 1
}

has_trailer() {
	local t prev="" want="$1"
	for t in "${TOKS[@]+"${TOKS[@]}"}"; do
		[[ "$t" == "--trailer=$want" ]] && return 0
		[[ "$prev" == "--trailer" && "$t" == "$want" ]] && return 0
		prev="$t"
	done
	return 1
}

CWD="$(agentkit_workdir)"; CWD="${CWD:-$PWD}"; PREV_CWD="$CWD"
SESSION=$(agentkit_session_id)
EDITOR_BIN="${WIKI_EDITOR_BIN:-}"
for candidate in "$HOME/.local/bin/wiki-editor" "${CLAUDE_PLUGIN_ROOT:-/nonexistent}/tools/wiki-editor" "$(command -v wiki-editor 2>/dev/null || true)"; do
	[[ -n "$EDITOR_BIN" ]] && break
	[[ -n "$candidate" && -x "$candidate" ]] && EDITOR_BIN="$candidate"
done

deny_unknown() {
	agentkit_deny_json "EDITOR UNKNOWN (editor-police)
This commit is in a repo whose commits must name the person editing, and this session has not said who that is.
Ask the user with AskUserQuestion, one question: who is editing right now? Options: $("$EDITOR_BIN" names 2>/dev/null | paste -sd, - | sed 's/,/, /g'), Other (type a name).
Record the answer once for this session:
  wiki-editor set <name> --session $SESSION
It prints the Edited-by line to use. Re-run the commit with that line written out in full:
  --trailer=\"Edited-by: Name <email>\"
An unexpanded \$(wiki-editor trailer ...) inside the commit is refused."
	exit 0
}


TRAILER=""

# The command a wrapper hands to a shell is a command too: bash -c "…",
# sh -c '…', eval "…". Judged like the outer one, with its own cd tracking.
nested_command() {
	local i=0 t
	GIT_DIR=""; skip_prefix; i=$PREFIX_END
	case "${TOKS[i]:-}" in
	eval) printf '%s' "${TOKS[*]:i+1}"; return 0 ;;
	bash | sh | zsh | dash | ksh) ;;
	*) return 1 ;;
	esac
	for ((i = i + 1; i < ${#TOKS[@]}; i++)); do
		t="${TOKS[i]}"
		case "$t" in
		--*) ;;
		-*c*) printf '%s' "${TOKS[i + 1]:-}"; return 0 ;;
		-*) ;;
		*) return 1 ;;
		esac
	done
	return 1
}

SEGMENTS=0
judge() {
	local depth="$2" rec inner saved_cwd roots root
	while IFS= read -r -d $'\002' rec || [[ -n "$rec" ]]; do
		[[ -z "$rec" || "$rec" == $'\005'* ]] && continue
		if ((++SEGMENTS > 1500)); then
			agentkit_deny_json "EDITOR GATE UNCHECKED (editor-police)
This command has more than 1500 shell statements, more than the gate can check inside its time budget. Split it up, or write it to a script file and run that."
			exit 0
		fi
		TOKS=()
		IFS=$'\003' read -r -d $'\004' -a TOKS <<<"${rec}"$'\004'
		((${#TOKS[@]})) || continue
		if [[ "${TOKS[0]}" == cd || "${TOKS[0]}" == pushd || "${TOKS[0]}" == popd ]]; then
			if [[ "${TOKS[0]}" == popd || "${TOKS[1]:-}" == - ]]; then
				t="$CWD"; CWD="$PREV_CWD"; PREV_CWD="$t"
			else
				PREV_CWD="$CWD"; CWD="$(abs_path "${TOKS[1]:-$HOME}")"
			fi
			continue
		fi
		if ((depth < 3)) && inner="$(nested_command)"; then
			saved_cwd="$CWD"
			judge "$inner" $((depth + 1))
			CWD="$saved_cwd"
			continue
		fi
		parse_git || continue
		[[ "$GIT_SUB" == commit ]] || continue
		roots="$(repo_roots "$GIT_DIR")"
		root="${roots%%$'\n'*}"
		matches_repo "$roots" || continue
		if [[ -z "$EDITOR_BIN" || ! -x "$EDITOR_BIN" ]]; then
			agentkit_deny_json "EDITOR TOOL MISSING (editor-police)
This repo is configured to name the person editing on every commit, but the wiki-editor tool is not installed.
Install agentkit's tools (./install.sh --global puts it at ~/.local/bin/wiki-editor) or set WIKI_EDITOR_BIN, then retry."
			exit 0
		fi
		[[ -n "$TRAILER" ]] || TRAILER=$("$EDITOR_BIN" trailer --session "$SESSION" 2>/dev/null) || deny_unknown
		has_trailer "$TRAILER" && continue
		agentkit_deny_json "EDITOR NOT ON THE COMMIT (editor-police)
The person editing in this session: ${TRAILER#Edited-by: }
Add exactly this to the git commit that targets $root:
  --trailer=\"$TRAILER\"
If someone else is editing now, first run: wiki-editor set <name> --session $SESSION"
		exit 0
	done < <(printf '%s' "$1" | tokenize)
}

judge "$COMMAND" 0
exit 0
