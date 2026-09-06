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

# A configured repo, by a path in the command or by the working directory.
glob_to_regex() { local g="$1"; g="${g//./\\.}"; g="${g//\*/[^/]+}"; printf '%s' "$g"; }
WORKDIR=$(agentkit_workdir)
matches_repo() {
	local pattern re
	for pattern in "${REPOS[@]+"${REPOS[@]}"}"; do
		re="$(glob_to_regex "$pattern")"
		local in_command="${re}(/|[[:space:]]|$|\")" in_workdir="${re}/"
		[[ "$COMMAND" =~ $in_command ]] && return 0
		[[ "${WORKDIR}/" =~ $in_workdir ]] && return 0
	done
	return 1
}
matches_repo || exit 0

SESSION=$(agentkit_session_id)
EDITOR_BIN="${WIKI_EDITOR_BIN:-}"
for candidate in "$HOME/.local/bin/wiki-editor" "${CLAUDE_PLUGIN_ROOT:-/nonexistent}/tools/wiki-editor" "$(command -v wiki-editor 2>/dev/null || true)"; do
	[[ -n "$EDITOR_BIN" ]] && break
	[[ -n "$candidate" && -x "$candidate" ]] && EDITOR_BIN="$candidate"
done
if [[ -z "$EDITOR_BIN" || ! -x "$EDITOR_BIN" ]]; then
	agentkit_deny_json "EDITOR TOOL MISSING (editor-police)
This repo is configured to name the person editing on every commit, but the wiki-editor tool is not installed.
Install agentkit's tools (./install.sh --global puts it at ~/.local/bin/wiki-editor) or set WIKI_EDITOR_BIN, then retry."
	exit 0
fi

if ! TRAILER=$("$EDITOR_BIN" trailer --session "$SESSION" 2>/dev/null); then
	agentkit_deny_json "EDITOR UNKNOWN (editor-police)
This commit is in a repo whose commits must name the person editing, and this session has not said who that is.
Ask the user with AskUserQuestion, one question: who is editing right now? Options: $("$EDITOR_BIN" names 2>/dev/null | paste -sd, - | sed 's/,/, /g'), Other (type a name).
Record the answer once for this session:
  wiki-editor set <name> --session $SESSION
It prints the Edited-by line to use. Re-run the commit with that line written out in full:
  --trailer=\"Edited-by: Name <email>\"
An unexpanded \$(wiki-editor trailer ...) inside the commit is refused.
Never guess the editor and never work around this with -c user.name or --no-verify."
	exit 0
fi

# Only the expanded trailer is accepted: an unexpanded $(wiki-editor …) form
# can substitute to nothing when the tool is not on PATH, and git takes an
# empty --trailer= without complaint.
for form in "--trailer=\"$TRAILER\"" "--trailer='$TRAILER'" "--trailer \"$TRAILER\"" "--trailer '$TRAILER'"; do
	[[ "$COMMAND" == *"$form"* ]] && exit 0
done

agentkit_deny_json "EDITOR NOT ON THE COMMIT (editor-police)
The person editing in this session: ${TRAILER#Edited-by: }
Add exactly this to the git commit:
  --trailer=\"$TRAILER\"
If someone else is editing now, first run: wiki-editor set <name> --session $SESSION"
