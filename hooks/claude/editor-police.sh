#!/usr/bin/env bash
# editor-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Several people can share one agent session, so a commit in a configured repo
# must name the person editing (an Edited-by trailer); the session answers once.
set -euo pipefail

AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"
RE_YAML_ITEM='^[[:space:]]*-[[:space:]]+(.*)'
# Same detector as git-police: any global options in any order, and never
# the words inside a quoted string (quotes are blanked before matching).
RE_GIT_COMMIT='\bgit([[:space:]]+(-[A-Za-z][^[:space:]]*|--[A-Za-z][A-Za-z0-9-]*(=[^[:space:]]+)?)([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit\b'
RE_ENABLED='^enabled:[[:space:]]*(.*)$'
RE_FLOW_LIST='^repos:[[:space:]]*\[(.*)\][[:space:]]*$'

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)
[[ -z "$COMMAND" ]] && exit 0

if [[ -n "${AGENTKIT_SKIP_HOOKS:-}" ]]; then
	_skip=",$(printf '%s' "$AGENTKIT_SKIP_HOOKS" | tr -d '[:space:]'),"
	case "$_skip" in
	*",editor-police,"* | *",all,"*) exit 0 ;;
	esac
fi

# Only git commits.
STRIPPED=$(printf '%s' "$COMMAND" | sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g" | sed -E "s/'[^']*'/''/g")
printf '%s' "$STRIPPED" | grep -qE "$RE_GIT_COMMIT" || exit 0

ENABLED=true
REPOS=()
unquote() { local v="$1"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"; printf '%s' "$v"; }
strip_comment() { local v="$1"; v="${v%%#*}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }
add_repo() { local item; item="$(unquote "$(strip_comment "$1")")"; [[ -n "$item" ]] && REPOS+=("$item"); }
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
# does it, not pattern-matched over the raw text: the command is split into
# simple segments on ; && || | and newlines outside quotes, each segment is
# tokenised with shell quoting honoured, `cd` moves the working directory for
# the segments after it, and a commit's repo is its -C path, its --git-dir, or
# that directory. Anything inside a quoted string (a commit message, a -F path)
# is never a repo and never a trailer.
glob_to_regex() { local g="$1"; g="${g//./\\.}"; g="${g//\*/[^/]+}"; printf '%s' "$g"; }

split_segments() {
	local cmd="$1" i c q="" seg="" n=${#1}
	for ((i = 0; i < n; i++)); do
		c="${cmd:i:1}"
		if [[ -n "$q" ]]; then
			seg+="$c"
			[[ "$c" == "$q" ]] && q=""
			[[ "$q" == '"' && "$c" == "\\" ]] && { i=$((i + 1)); seg+="${cmd:i:1}"; }
			continue
		fi
		case "$c" in
		"'" | '"') q="$c"; seg+="$c" ;;
		"\\") seg+="$c"; i=$((i + 1)); seg+="${cmd:i:1}" ;;
		";" | "|" | "(" | ")" | "{" | "}" | $'\n') printf '%s\n' "$seg"; seg=""; [[ "${cmd:i+1:1}" == "|" ]] && i=$((i + 1)) ;;
		"&") if [[ "${cmd:i+1:1}" == "&" ]]; then printf '%s\n' "$seg"; seg=""; i=$((i + 1)); else seg+="$c"; fi ;;
		*) seg+="$c" ;;
		esac
	done
	printf '%s\n' "$seg"
}

# Tokens of one segment, one per line, shell quoting honoured and nothing
# expanded: an unexpanded $(…) stays the literal text it is.
tokens() { printf '%s' "$1" | xargs printf '%s\n' 2>/dev/null; }

abs_path() {
	local d="${1/#\~/$HOME}"
	[[ "$d" == /* ]] || d="$CWD/$d"
	if [[ -d "$d" ]]; then (cd "$d" 2>/dev/null && pwd -P) || printf '%s' "$d"; else printf '%s' "$d"; fi
}

# The repo a git segment operates on: -C, --git-dir, else the tracked cwd.
git_target_dir() {
	local seen_git=false expect="" t dir=""
	while IFS= read -r t; do
		if ! $seen_git; then [[ "$t" == git ]] && seen_git=true; continue; fi
		if [[ -n "$expect" ]]; then
			[[ "$expect" == dir ]] && dir="$t"
			expect=""; continue
		fi
		case "$t" in
		-C) expect=dir ;;
		-C?*) dir="${t#-C}" ;;
		-c | --work-tree | --namespace | --exec-path) expect=skip ;;
		--git-dir=*) dir="${t#--git-dir=}"; dir="${dir%/.git}"; dir="${dir%/}" ;;
		--git-dir) expect=dir ;;
		--*=* | --* | -*) ;;
		*) break ;;
		esac
	done <<<"$1"
	printf '%s' "${dir:-$CWD}"
}

repo_root() {
	local d; d="$(abs_path "$1")"
	git -C "$d" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$d"
}

matches_repo() {
	local pattern re root="$1"
	for pattern in "${REPOS[@]+"${REPOS[@]}"}"; do
		re="(^|/)$(glob_to_regex "$pattern")/"
		[[ "${root}/" =~ $re ]] && return 0
	done
	return 1
}

blank_quotes() { printf '%s' "$1" | sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g" | sed -E "s/'[^']*'/''/g"; }

has_trailer() {
	local t prev="" want="$2"
	while IFS= read -r t; do
		[[ "$t" == "--trailer=$want" ]] && return 0
		[[ "$prev" == "--trailer" && "$t" == "$want" ]] && return 0
		prev="$t"
	done <<<"$1"
	return 1
}

CWD="$(agentkit_workdir)"; CWD="${CWD:-$PWD}"
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
while IFS= read -r seg; do
	[[ -z "${seg//[[:space:]]/}" ]] && continue
	toks="$(tokens "$seg")" || {
		agentkit_deny_json "UNPARSEABLE COMMAND (editor-police)
This command has unbalanced quotes, so the commit it may contain cannot be checked for the editing person. Fix the quoting and retry."
		exit 0
	}
	first="$(printf '%s\n' "$toks" | head -1)"
	if [[ "$first" == cd ]]; then
		CWD="$(abs_path "$(printf '%s\n' "$toks" | sed -n 2p)")"
		continue
	fi
	printf '%s' "$(blank_quotes "$seg")" | grep -qE "$RE_GIT_COMMIT" || continue
	root="$(repo_root "$(git_target_dir "$toks")")"
	matches_repo "$root" || continue
	if [[ -z "$EDITOR_BIN" || ! -x "$EDITOR_BIN" ]]; then
		agentkit_deny_json "EDITOR TOOL MISSING (editor-police)
This repo is configured to name the person editing on every commit, but the wiki-editor tool is not installed.
Install agentkit's tools (./install.sh --global puts it at ~/.local/bin/wiki-editor) or set WIKI_EDITOR_BIN, then retry."
		exit 0
	fi
	[[ -n "$TRAILER" ]] || TRAILER=$("$EDITOR_BIN" trailer --session "$SESSION" 2>/dev/null) || deny_unknown
	has_trailer "$toks" "$TRAILER" && continue
	agentkit_deny_json "EDITOR NOT ON THE COMMIT (editor-police)
The person editing in this session: ${TRAILER#Edited-by: }
Add exactly this to the git commit in: $seg
  --trailer=\"$TRAILER\"
If someone else is editing now, first run: wiki-editor set <name> --session $SESSION"
	exit 0
done <<<"$(split_segments "$COMMAND")"
exit 0
