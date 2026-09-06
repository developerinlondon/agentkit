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
# with tokens \003-separated; a segment left inside an open quote is marked with
# a leading \005 and skipped, because bash refuses such a command outright.
glob_to_regex() { local g="$1"; g="${g//./\\.}"; g="${g//\*/[^/]+}"; printf '%s' "$g"; }

tokenize() {
	LC_ALL=C awk 'BEGIN { RS = "\001" }
	{
		s = $0; n = length(s); seg = ""; tok = ""; intok = 0; q = ""
		for (i = 1; i <= n; i++) {
			c = substr(s, i, 1)
			if (q != "") {
				if (c == q) { q = "" }
				else if (q == "\"" && c == "\\") { i++; tok = tok substr(s, i, 1) }
				else { tok = tok c }
				intok = 1; continue
			}
			if (c == "\047" || c == "\"") { q = c; intok = 1; continue }
			if (c == "\\") { i++; tok = tok substr(s, i, 1); intok = 1; continue }
			if (c == " " || c == "\t") { if (intok) { seg = seg tok "\003"; tok = ""; intok = 0 }; continue }
			if (c == ";" || c == "|" || c == "&" || c == "(" || c == ")" || c == "{" || c == "}" || c == "\n") {
				if (intok) { seg = seg tok "\003"; tok = ""; intok = 0 }
				printf "%s\002", seg; seg = ""
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

# Sets GIT_SUB and GIT_DIR from the segment's tokens when they run git,
# allowing the usual wrappers in front (env, sudo, VAR=value …). The dir is
# -C, --git-dir, or the tracked working directory.
parse_git() {
	GIT_SUB=""; GIT_DIR=""
	local i=0 t expect=""
	while ((i < ${#TOKS[@]})); do
		t="${TOKS[i]}"
		case "$t" in
		git) break ;;
		env | sudo | command | nice | time | nohup | bounded-run | -- | -* | *=*) i=$((i + 1)) ;;
		*) return 1 ;;
		esac
	done
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

has_trailer() {
	local t prev="" want="$1"
	for t in "${TOKS[@]+"${TOKS[@]}"}"; do
		[[ "$t" == "--trailer=$want" ]] && return 0
		[[ "$prev" == "--trailer" && "$t" == "$want" ]] && return 0
		prev="$t"
	done
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
while IFS= read -r -d $'\002' rec || [[ -n "$rec" ]]; do
	[[ -z "$rec" || "$rec" == $'\005'* ]] && continue
	TOKS=()
	IFS=$'\003' read -r -d $'\004' -a TOKS <<<"${rec}"$'\004'
	((${#TOKS[@]})) || continue
	if [[ "${TOKS[0]}" == cd ]]; then
		CWD="$(abs_path "${TOKS[1]:-$HOME}")"
		continue
	fi
	parse_git || continue
	[[ "$GIT_SUB" == commit ]] || continue
	root="$(repo_root "$GIT_DIR")"
	matches_repo "$root" || continue
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
done < <(printf '%s' "$COMMAND" | tokenize)
exit 0
