#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=false
TARGET_DIR=""

usage() {
	cat <<'USAGE'
Usage: ./install.sh [options] [target-project-dir]

Installs agentkit (skills + rules + plugins + hooks + tools + policies) for all
supported AI coding tools: OpenCode, Claude Code, Codex CLI, and Grok CLI.

Options:
  --global             Install globally (all tools, all projects)
  --with <group>       Also install an opt-in skill group (repeatable). Groups
                       are declared in skills/GROUPS; every unlisted skill is
                       in the always-installed `core` group.
                         --with product        product-intelligence, product-review
                         --with strict-review  adversarial-review + hard merge gate
                       (`--with review` remains an alias for strict-review.)
                       A global install run on a terminal with no group flags
                       and nothing remembered yet asks about each optional
                       group instead; every other run is unattended.
                       Groups marked `explicit` in skills/GROUPS
                       (strict-review) are never offered by that prompt and are
                       excluded from --all: only a literal --with installs
                       them, and when one is not selected the installer REMOVES
                       its previously installed hooks, tools, skills, and
                       prompt wiring.
  --no-prompt          Never ask about optional groups, even on a terminal.
                       AGENTKIT_SKIP_PROMPT=1 and a non-empty CI do the same.
  --without <group>    Drop a group from the selection and from the remembered
                       set (repeatable). Skills already installed are left in
                       place; `core` cannot be dropped.
  --all                Install every declared skill group. A global install
                       remembers the chosen groups in ~/.agentkit/groups, so a
                       later bare `install.sh --global` upgrades the same set
                       without re-passing flags.
  --claude-plugin      Global only: install Claude Code bits as the agentkit
                       plugin (marketplace add + plugin install) INSTEAD of
                       copying hooks/skills and merging settings.json. The two
                       modes are mutually exclusive — plugin hooks.json on top
                       of settings.json hooks would fire every hook twice.
  --no-session-scope   Global only: skip the per-session resource shims that
                       run each agent CLI in its own systemd scope, and leave
                       ~/.bashrc untouched.
  target-project-dir   Project directory to install into (default: current dir)

Global install locations:
  Shared root: ~/.agentkit/{skills,rules,instructions,hooks,tools}
               (single copy — clients get per-entry symlinks, so non-agentkit
               skills in ~/.claude/skills or ~/.grok/skills are left alone)
  OpenCode:    ~/.agents/skills|rules|instructions → ~/.agentkit/…
               ~/.config/opencode/plugins/ (TS plugins still copied)
  Claude Code: ~/.claude/skills|hooks|tools → ~/.agentkit/… (per entry)
               ~/.claude/settings.json (hooks section merged)
               (--claude-plugin: agentkit plugin via marketplace instead)
  Grok CLI:    ~/.grok/skills|rules → ~/.agentkit/… (per entry)
               instructions also land as ~/.grok/rules/*.md for always-on load
  Codex CLI:   $CODEX_HOME when set, otherwise ~/.codex
               (rules, prompts, hooks.json, and review gate scripts)
  Executables: ~/.local/bin/ (also mirrored under ~/.agentkit/tools/)
  Prompts:     ~/.agentkit/instructions/*.md (wired into Codex/Claude/OpenCode/Grok)

Project install locations:
  OpenCode:    .opencode/skills/, .opencode/plugins/, .opencode/rules/
  Claude Code: .claude/skills/, .claude/hooks/, .claude/tools/,
               .claude/settings.json (hooks section merged)
  Codex CLI:   .codex/rules/, .codex/hooks.json, .codex/{hooks,tools}/

Examples:
  ./install.sh --global               # Install for all tools globally
  ./install.sh --global --with product   # …plus the opt-in product skills
  ./install.sh --global --claude-plugin  # Claude Code via plugin, rest as usual
  ./install.sh                        # Install into current project
  ./install.sh ~/code/my-project      # Install into specific project
USAGE
	exit "${1:-1}"
}

# Single shared content root. Clients never get a second full tree — only
# per-name symlinks into this directory (preserves OMC/Grok builtin skills).
AGENTKIT_HOME="${AGENTKIT_HOME:-$HOME/.agentkit}"

CLAUDE_PLUGIN=false
SESSION_SCOPE=true
EXTRA_GROUPS=""
DROP_GROUPS=""
ALL_GROUPS=false
PROMPT=true
# Environment that makes a run unattended whatever is attached to it. Declared
# as one list because it is also what a test asserting the prompt fires has to
# clear from its own environment — a CI runner exports CI to everything it
# starts, so a second copy of these names would drift and silence the wizard
# in exactly the place it is being tested.
PROMPT_SUPPRESSING_ENV="CI AGENTKIT_SKIP_PROMPT"
while [[ $# -gt 0 ]]; do
	case "$1" in
	-h | --help) usage ;;
	--global) GLOBAL=true ;;
	--claude-plugin) CLAUDE_PLUGIN=true ;;
	--no-session-scope) SESSION_SCOPE=false ;;
	--no-prompt) PROMPT=false ;;
	--with)
		shift
		if [[ $# -eq 0 ]]; then
			echo "ERROR: --with requires a group name (e.g. --with product)." >&2
			exit 1
		fi
		EXTRA_GROUPS="${EXTRA_GROUPS:+$EXTRA_GROUPS }$1"
		;;
	--with=*) EXTRA_GROUPS="${EXTRA_GROUPS:+$EXTRA_GROUPS }${1#--with=}" ;;
	--without)
		shift
		if [[ $# -eq 0 ]]; then
			echo "ERROR: --without requires a group name (e.g. --without product)." >&2
			exit 1
		fi
		DROP_GROUPS="${DROP_GROUPS:+$DROP_GROUPS }$1"
		;;
	--without=*) DROP_GROUPS="${DROP_GROUPS:+$DROP_GROUPS }${1#--without=}" ;;
	--all) ALL_GROUPS=true ;;
	# Without this, a typo'd flag is captured as the target directory and the
	# install silently does something other than what was asked for.
	-*)
		echo "ERROR: unknown option '$1'." >&2
		usage 2 >&2
		;;
	*) TARGET_DIR="$1" ;;
	esac
	shift
done

if [[ "$CLAUDE_PLUGIN" == true && "$GLOBAL" != true ]]; then
	echo "ERROR: --claude-plugin requires --global (plugins are user-level)." >&2
	exit 1
fi

# ─── Shared: Skill Groups ────────────────────────────────────────────────────

# shellcheck source=lib/skill-groups.sh
source "$REPO_DIR/lib/skill-groups.sh"
validate_skill_groups || exit 1

# The group shipped as `review` before it was renamed `strict-review`. Both ways
# a name reaches the selection — a flag now, a selection persisted by an older
# install — normalize the old spelling so neither becomes an unknown group.
# Kept above `group_selected` deliberately: tests lift the block between that
# function and the validation loop below, and this needs the parsed flags.
GROUP_RENAMED_FROM=review
GROUP_RENAMED_TO=strict-review

normalize_group_list() {
	local group out=""
	for group in $1; do
		if [[ "$group" == "$GROUP_RENAMED_FROM" ]]; then group="$GROUP_RENAMED_TO"; fi
		out="${out:+$out }$group"
	done
	printf '%s' "$out"
}

# Said once for the whole command line: two flags naming it are still one rename.
case " $EXTRA_GROUPS $DROP_GROUPS " in
*" $GROUP_RENAMED_FROM "*)
	echo "[groups] '$GROUP_RENAMED_FROM' is now '$GROUP_RENAMED_TO' — accepted as an alias" >&2
	EXTRA_GROUPS="$(normalize_group_list "$EXTRA_GROUPS")"
	DROP_GROUPS="$(normalize_group_list "$DROP_GROUPS")"
	;;
esac

group_selected() {
	case " $SELECTED_GROUPS " in
	*" $1 "*) return 0 ;;
	esac
	return 1
}

for requested_group in $EXTRA_GROUPS $DROP_GROUPS; do
	if ! group_declared "$requested_group"; then
		echo "ERROR: unknown skill group '$requested_group'." >&2
		echo "       Declared groups: $(declared_groups | tr '\n' ' ')" >&2
		exit 1
	fi
done

for requested_group in $DROP_GROUPS; do
	if [[ "$requested_group" == core ]]; then
		echo "ERROR: the core group cannot be deselected." >&2
		exit 2
	fi
done

# Selection persists in the shared root so a later bare `install.sh --global`
# upgrades the same set of groups without re-passing flags.
GROUPS_STATE_FILE="$AGENTKIT_HOME/groups"

read_persisted_groups() {
	[[ "$GLOBAL" == true && -f "$GROUPS_STATE_FILE" ]] || return 0
	local entry
	while read -r entry _; do
		case "$entry" in '' | '#'*) continue ;; esac
		# Silent here, unlike the flag path: the operator did not type this name.
		if [[ "$entry" == "$GROUP_RENAMED_FROM" ]]; then entry="$GROUP_RENAMED_TO"; fi
		# A stale entry must not resurrect a selection, and must not decide the
		# loop's exit status: as the tail, a bare `cond && action` returning 1
		# kills the whole install under set -e with nothing printed.
		if group_declared "$entry"; then
			printf '%s\n' "$entry"
		else
			echo "[groups] Ignoring unknown group in $GROUPS_STATE_FILE: $entry" >&2
		fi
	done <"$GROUPS_STATE_FILE"
	return 0
}

write_persisted_groups() {
	[[ "$GLOBAL" == true ]] || return 0
	local group
	mkdir -p "$(dirname "$GROUPS_STATE_FILE")"
	{
		echo "# Skill groups chosen at install time; a bare install.sh --global keeps them."
		echo "# Delete a line to stop installing that group (installed skills are left alone)."
		for group in $SELECTED_GROUPS; do
			[[ "$group" == core ]] || echo "$group"
		done
	} >"$GROUPS_STATE_FILE"
}

group_dropped() {
	case " $DROP_GROUPS " in
	*" $1 "*) return 0 ;;
	esac
	return 1
}

prompt_suppressed_by_env() {
	local name
	for name in $PROMPT_SUPPRESSING_ENV; do
		if [[ -n "${!name:-}" ]]; then
			return 0
		fi
	done
	return 1
}

# An unanswered question does not degrade to a decline, it stops the install
# until something kills it, so every condition here fails towards silence.
should_prompt_for_groups() {
	# Only a global install has anywhere to record an answer, and a question
	# whose answer cannot be kept is a nag repeated at every project.
	[[ "$GLOBAL" == true ]] || return 1
	# Both descriptors, not just stdin: output routed into a pipe or a log means
	# an operator who cannot see the question, whatever is attached to stdin.
	[[ -t 0 && -t 1 ]] || return 1
	# A terminal is not evidence of a person. Docker executors, `docker run -it`
	# and Jenkins all hand a job a pty with nobody behind it.
	if prompt_suppressed_by_env; then
		return 1
	fi
	[[ "$PROMPT" == true ]] || return 1
	[[ "$ALL_GROUPS" == false ]] || return 1
	[[ -z "$EXTRA_GROUPS" && -z "$DROP_GROUPS" ]] || return 1
	# Where the file exists the question was already put, and an empty one is
	# the recorded answer "core only" rather than an absent answer.
	[[ ! -f "$GROUPS_STATE_FILE" ]] || return 1
	return 0
}

# The question belongs on the terminal, not in whatever the caller is capturing.
# `exec` redirections are permanent, so openability is probed in a subshell: a
# failed probe must not leave the installer's own stderr pointing at /dev/null.
open_prompt_channel() {
	if (exec 3<>/dev/tty) 2>/dev/null; then
		exec 3<>/dev/tty
		exec 4<&3
		return 0
	fi
	return 1
}

prompt_for_groups() {
	local group description reply header=false
	# Nowhere to hold the conversation. Asking anyway would put the question
	# somewhere nobody is reading and then wait forever for the answer, so this
	# declines like every other unattended shape and says so once, out loud.
	if ! open_prompt_channel; then
		echo "[groups] No controlling terminal — installing core only." >&2
		echo "[groups] Use --with <group> to add an optional group." >&2
		return 0
	fi
	for group in $(declared_groups); do
		if [[ "$group" == core ]]; then continue; fi
		# Explicit groups are consent-gated: a y at a prompt is too easy to give
		# without reading what it wires in. Only a literal --with installs them.
		if group_explicit "$group"; then continue; fi
		if [[ "$header" == false ]]; then
			echo "[groups] Optional skill groups — core installs either way." >&3
			header=true
		fi
		description="$(group_description "$group")"
		echo "[groups]   $group: $description" >&3
		printf '[groups]   Install %s? [y/N] ' "$group" >&3
		# A closed terminal answers nothing; taking the default beats looping on
		# an empty read or aborting an install that is otherwise fine.
		if ! read -r reply <&4; then
			reply=""
			echo "" >&3
		fi
		case "$reply" in
		[yY] | [yY][eE][sS]) EXTRA_GROUPS="${EXTRA_GROUPS:+$EXTRA_GROUPS }$group" ;;
		esac
	done
	if [[ "$header" == true ]]; then echo "" >&3; fi
	exec 3>&- 4<&-
	return 0
}

select_groups() {
	local candidates group
	if [[ "$ALL_GROUPS" == true ]]; then
		# --all never covers explicit groups; those still arrive only via a
		# literal --with (or a selection previously persisted from one).
		candidates=""
		for group in $(declared_groups); do
			if group_explicit "$group"; then continue; fi
			candidates="${candidates:+$candidates }$group"
		done
		candidates="$candidates $EXTRA_GROUPS $(read_persisted_groups)"
	else
		candidates="core $EXTRA_GROUPS $(read_persisted_groups)"
	fi

	SELECTED_GROUPS="core"
	for group in $candidates; do
		if group_dropped "$group"; then continue; fi
		group_selected "$group" || SELECTED_GROUPS="$SELECTED_GROUPS $group"
	done
	return 0
}

if should_prompt_for_groups; then
	prompt_for_groups
fi

select_groups

# shellcheck source=lib/install-platform.sh
source "$REPO_DIR/lib/install-platform.sh"
PLATFORM="$(detect_platform)"
validate_platform "$PLATFORM"
if [[ "$GLOBAL" == true && "$SESSION_SCOPE" == true && "$PLATFORM" != linux ]]; then
	echo "[shims] Session scoping is Linux-only; skipping on $PLATFORM."
	SESSION_SCOPE=false
fi

# ─── Shared: Skills ──────────────────────────────────────────────────────────

# Point dest at src as a symlink. Replaces a previous real file/dir or wrong
# link so re-install is idempotent. Never touches sibling entries in dest's
# parent — that is how ~/.claude/skills keeps OMC skills next to agentkit ones.
link_path() {
	local src="$1"
	local dest="$2"
	mkdir -p "$(dirname "$dest")"
	if [[ -L "$dest" ]]; then
		if [[ "$(readlink "$dest")" == "$src" ]]; then
			return 0
		fi
		rm -f "$dest"
	elif [[ -e "$dest" ]]; then
		rm -rf "$dest"
	fi
	ln -sfn "$src" "$dest"
	echo "[link] $dest -> $src"
}

# Remove symlinks in a client dir whose target no longer exists under the
# shared root — the client-side counterpart of removing a canon entry. Only
# agentkit-owned links (targets inside AGENTKIT_HOME) are touched; a broken
# link the user made by hand is not ours to delete.
prune_dangling_links() {
	local dir="$1"
	[[ -d "$dir" ]] || return 0
	local entry target
	for entry in "$dir"/*; do
		[[ -L "$entry" ]] || continue
		target="$(readlink "$entry")"
		case "$target" in
		"$AGENTKIT_HOME"/*) ;;
		*) continue ;;
		esac
		if [[ ! -e "$target" ]]; then
			rm -f "$entry"
			echo "[link] Pruned dangling: $entry"
		fi
	done
	return 0
}

# Symlink every direct child of canon into each client dir (by basename).
link_children() {
	local canon="$1"
	shift
	[[ -d "$canon" ]] || return 0
	local client name
	for client in "$@"; do
		[[ -n "$client" ]] || continue
		mkdir -p "$client"
		for entry in "$canon"/*; do
			[[ -e "$entry" ]] || continue
			name="$(basename "$entry")"
			link_path "$canon/$name" "$client/$name"
		done
	done
}

install_skills() {
	local dest="$1"
	local bun_bin=""
	mkdir -p "$dest"
	if command -v bun >/dev/null 2>&1; then
		# Version-manager shims such as mise resolve from the current directory.
		# Capture Bun's real executable while still inside the AgentKit checkout;
		# re-resolving the shim after cd'ing into a copied skill can lose the pin.
		bun_bin="$(cd "$REPO_DIR" && bun -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)"
	fi

	for skill_dir in "$REPO_DIR"/skills/*/; do
		local skill_name group
		skill_name="$(basename "$skill_dir")"
		local target="$dest/$skill_name"
		group="$(skill_group "$skill_name")"

		# An unselected group that is already installed is still refreshed:
		# dropping it on upgrade would silently take a skill away from someone
		# who is using it, and leaving it unupdated rots it instead. Explicit
		# groups invert that: they are consent-gated, and presence without a
		# recorded selection is not consent — remove them.
		if ! group_selected "$group"; then
			if group_explicit "$group"; then
				if [[ -e "$target" ]]; then
					echo "[skills] Removing (explicit group '$group' not selected): $skill_name"
					rm -rf "$target"
				else
					echo "[skills] Skipping (explicit group '$group' — add --with $group): $skill_name"
				fi
				continue
			fi
			if [[ -e "$target" ]]; then
				echo "[skills] Keeping installed (group '$group' not selected): $skill_name"
			else
				echo "[skills] Skipping (group '$group' — add --with $group): $skill_name"
				continue
			fi
		fi

		if [[ -d "$target" && ! -L "$target" ]]; then
			echo "[skills] Updating: $skill_name"
			rm -rf "$target"
		elif [[ -L "$target" ]]; then
			# Should not happen for the canonical tree; defend anyway.
			rm -f "$target"
			echo "[skills] Installing: $skill_name"
		else
			echo "[skills] Installing: $skill_name"
		fi

		cp -r "$skill_dir" "$target"

		# Skills that ship runtime dependencies (a package.json) need an install
		# step: bun does NOT auto-install when a package.json is present.
		if [[ -f "$target/package.json" ]]; then
			if [[ -n "$bun_bin" && -x "$bun_bin" ]]; then
				echo "[skills] Installing dependencies: $skill_name"
				(cd "$target" && "$bun_bin" install --silent)
				# Build-time artifacts (e.g. browser bundles) are gitignored and
				# produced at install via the skill's own build script.
				if grep -A3 '"scripts"' "$target/package.json" | grep -q '"build"'; then
					echo "[skills] Building: $skill_name"
					(cd "$target" && "$bun_bin" run build >/dev/null)
				fi
			else
				echo "[skills] WARNING: $skill_name needs 'bun install' in $target (usable bun executable not found)"
			fi
		fi
	done
}

install_rules() {
	local dest="$1"
	mkdir -p "$dest"

	for rule_file in "$REPO_DIR"/rules/*.md; do
		[[ -f "$rule_file" ]] || continue
		local name
		name="$(basename "$rule_file")"

		if [[ -f "$dest/$name" && ! -L "$dest/$name" ]]; then
			echo "[rules] Updating: $name"
		elif [[ ! -e "$dest/$name" ]]; then
			echo "[rules] Installing: $name"
		else
			echo "[rules] Updating: $name"
			rm -f "$dest/$name"
		fi

		cp "$rule_file" "$dest/$name"
	done
}

# ─── Shared: Global Agent Prompts ────────────────────────────────────────────

prompt_basename() {
	basename "$1" .md
}

prompt_marker_start() {
	echo "<!-- agentkit:$(prompt_basename "$1"):start -->"
}

prompt_marker_end() {
	echo "<!-- agentkit:$(prompt_basename "$1"):end -->"
}

prompt_title() {
	grep -m1 '^# ' "$1" | sed 's/^# //'
}

set_codex_developer_instructions() {
	local file="$1"
	local prompt_file="$2"
	local tmp="${file}.tmp"

	mkdir -p "$(dirname "$file")"
	touch "$file"

	awk -v source="$prompt_file" '
		function print_prompt() {
			print "developer_instructions = \"\"\""
			while ((getline line < source) > 0) {
				print line
			}
			close(source)
			print "\"\"\""
		}
		BEGIN {
			done = 0
			in_section = 0
			skip_multiline = 0
		}
		skip_multiline && /^[[:space:]]*"""[[:space:]]*$/ {
			skip_multiline = 0
			next
		}
		skip_multiline {
			next
		}
		/^[[:space:]]*\[/ {
			if (!done) {
				if (NR > 1) {
					print ""
				}
				print_prompt()
				done = 1
			}
			in_section = 1
			print
			next
		}
		!in_section && /^[[:space:]]*model_instructions_file[[:space:]]*=/ {
			next
		}
		!in_section && /^[[:space:]]*developer_instructions[[:space:]]*=/ {
			if (!done) {
				print_prompt()
				done = 1
			}
			if ($0 ~ /"""[[:space:]]*$/ && $0 !~ /^[[:space:]]*developer_instructions[[:space:]]*=[[:space:]]*""".*"""[[:space:]]*$/) {
				skip_multiline = 1
			}
			next
		}
		{
			print
		}
		END {
			if (!done) {
				if (NR > 0) {
					print ""
				}
				print_prompt()
			}
		}
	' "$file" >"$tmp"
	mv "$tmp" "$file"
}

install_agent_prompt_file() {
	local instructions_dir="$1"
	local source_file="$2"
	local name
	name="$(basename "$source_file")"
	mkdir -p "$instructions_dir"

	if [[ -f "$instructions_dir/$name" ]]; then
		echo "[prompt] Updating: $instructions_dir/$name"
	else
		echo "[prompt] Installing: $instructions_dir/$name"
	fi

	cp "$source_file" "$instructions_dir/$name"
}

codex_has_managed_prompt() {
	local config_file="$1"
	local instructions_dir="$2"
	local prompt_file title
	if grep -Fq "agentkit:" "$config_file"; then
		return 0
	fi
	for prompt_file in "$instructions_dir"/*.md; do
		[[ -f "$prompt_file" ]] || continue
		title="$(prompt_title "$prompt_file")"
		if [[ -n "$title" ]] && grep -Fq "$title" "$config_file"; then
			return 0
		fi
	done
	return 1
}

install_codex_prompts() {
	local instructions_dir="$1"
	local config_file="${CODEX_HOME:-$HOME/.codex}/config.toml"

	if [[ -f "$config_file" ]] \
		&& grep -Eq '^[[:space:]]*developer_instructions[[:space:]]*=' "$config_file" \
		&& ! codex_has_managed_prompt "$config_file" "$instructions_dir"; then
		echo "[codex] WARNING: developer_instructions already exists without agentkit prompt; leaving unchanged: $config_file"
		return
	fi

	local combined_file
	combined_file="$(mktemp)"
	local first=true
	local prompt_file
	for prompt_file in "$instructions_dir"/*.md; do
		[[ -f "$prompt_file" ]] || continue
		if $first; then
			first=false
		else
			echo "" >>"$combined_file"
		fi
		cat "$prompt_file" >>"$combined_file"
	done

	set_codex_developer_instructions "$config_file" "$combined_file"
	rm -f "$combined_file"
	echo "[codex] Wired developer_instructions: $config_file"
}

install_claude_prompt() {
	local prompt_file="$1"
	local claude_file="$HOME/.claude/CLAUDE.md"
	local tmp="${claude_file}.tmp"
	local name
	local marker_start
	local marker_end
	local title
	name="$(basename "$prompt_file")"
	marker_start="$(prompt_marker_start "$prompt_file")"
	marker_end="$(prompt_marker_end "$prompt_file")"
	title="$(prompt_title "$prompt_file")"

	mkdir -p "$(dirname "$claude_file")"

	if [[ ! -f "$claude_file" ]]; then
		cp "$prompt_file" "$claude_file"
		echo "[claude] Created global instructions with $name: $claude_file"
		return
	fi

	if grep -Fq "$marker_start" "$claude_file"; then
		awk -v source="$prompt_file" -v start="$marker_start" -v end="$marker_end" '
			function print_source() {
				while ((getline line < source) > 0) {
					print line
				}
				close(source)
			}
			$0 == start {
				print_source()
				skip = 1
				next
			}
			skip && $0 == end {
				skip = 0
				next
			}
			!skip {
				print
			}
		' "$claude_file" >"$tmp"
		mv "$tmp" "$claude_file"
		echo "[claude] Updated prompt block ($name): $claude_file"
	elif [[ -n "$title" ]] && grep -Fq "$title" "$claude_file"; then
		echo "[claude] Prompt already present without agentkit markers ($name): $claude_file"
	else
		{
			printf '\n'
			cat "$prompt_file"
		} >>"$claude_file"
		echo "[claude] Added prompt block ($name): $claude_file"
	fi
}

install_opencode_prompt() {
	local prompt_file="$1"
	local config_dir="$HOME/.config/opencode"
	local config_file="$config_dir/opencode.json"
	local tmp="${config_file}.tmp"

	if ! command -v jq &>/dev/null; then
		echo "[opencode] WARNING: jq not found. Cannot wire global prompt into opencode.json."
		return
	fi

	mkdir -p "$config_dir"

	if [[ ! -f "$config_file" ]]; then
		jq -n --arg prompt "$prompt_file" '{
			"$schema": "https://opencode.ai/config.json",
			instructions: [$prompt]
		}' >"$config_file"
		echo "[opencode] Created config with global prompt: $config_file"
		return
	fi

	jq --arg prompt "$prompt_file" '
		.instructions = (
			reduce ((.instructions // []) + [$prompt])[] as $entry (
				[];
				if index($entry) then . else . + [$entry] end
			)
		)
	' "$config_file" >"$tmp"
	mv "$tmp" "$config_file"
	echo "[opencode] Wired global prompt: $config_file"
}

# Grok loads always-on home rules from ~/.grok/rules/*.md (and AGENTS.md).
# Point each instruction at rules/ so Grok does not depend on Claude-compat
# loading ~/.claude/CLAUDE.md for agentkit prompts.
install_grok_prompt() {
	local prompt_file="$1"
	local rules_dir="$HOME/.grok/rules"
	local name
	name="$(basename "$prompt_file")"
	mkdir -p "$rules_dir"
	link_path "$prompt_file" "$rules_dir/$name"
}

instruction_group() {
	case "$(basename "$1")" in
	evidence-gated-review.md) printf 'strict-review' ;;
	# Instructions are concatenated into every prompt, so a core one costs context
	# on every session whether or not the work needs a review pass.
	review-discipline.md) printf 'review-discipline' ;;
	*) printf 'core' ;;
	esac
}

remove_claude_prompt() {
	local name="$1"
	local title="$2"
	local claude_file="$HOME/.claude/CLAUDE.md"
	local tmp="${claude_file}.tmp"
	local marker_start="<!-- agentkit:${name%.md}:start -->"
	local marker_end="<!-- agentkit:${name%.md}:end -->"

	[[ -f "$claude_file" ]] || return 0

	if grep -Fq "$marker_start" "$claude_file"; then
		awk -v start="$marker_start" -v end="$marker_end" '
			$0 == start { skip = 1; next }
			skip && $0 == end { skip = 0; next }
			!skip { print }
		' "$claude_file" >"$tmp"
	elif [[ -n "$title" ]] && grep -Fxq "# $title" "$claude_file"; then
		# Legacy blocks were appended without markers; the prompt is one
		# top-level section, so strip from its heading to the next one.
		awk -v heading="# $title" '
			$0 == heading { skip = 1; next }
			skip && /^# / { skip = 0 }
			!skip { print }
		' "$claude_file" >"$tmp"
	else
		return 0
	fi
	mv "$tmp" "$claude_file"
	echo "[claude] Removed prompt block ($name): $claude_file"
}

remove_opencode_prompt() {
	local prompt_file="$1"
	local config_file="$HOME/.config/opencode/opencode.json"
	local tmp="${config_file}.tmp"

	[[ -f "$config_file" ]] || return 0
	command -v jq &>/dev/null || return 0
	jq -e --arg prompt "$prompt_file" '(.instructions // []) | index($prompt)' \
		"$config_file" >/dev/null 2>&1 || return 0

	jq --arg prompt "$prompt_file" \
		'.instructions = ((.instructions // []) | map(select(. != $prompt)))' \
		"$config_file" >"$tmp"
	mv "$tmp" "$config_file"
	echo "[opencode] Removed global prompt: $config_file"
}

remove_agent_prompt_file() {
	local instructions_dir="$1"
	local name="$2"
	local canon_file="$instructions_dir/$name"
	local title=""
	[[ -f "$REPO_DIR/instructions/$name" ]] && title="$(prompt_title "$REPO_DIR/instructions/$name")"

	remove_claude_prompt "$name" "$title"
	remove_opencode_prompt "$canon_file"
	rm -f "$HOME/.grok/rules/$name" "$HOME/.agents/instructions/$name"
	if [[ -e "$canon_file" ]]; then
		rm -f "$canon_file"
		echo "[prompt] Removed (group not selected): $canon_file"
	fi
}

install_global_agent_prompt() {
	local instructions_dir="${1:-$AGENTKIT_HOME/instructions}"
	mkdir -p "$instructions_dir"

	local source_file
	local found=false
	for source_file in "$REPO_DIR"/instructions/*.md; do
		[[ -f "$source_file" ]] || continue
		if ! group_selected "$(instruction_group "$source_file")"; then
			remove_agent_prompt_file "$instructions_dir" "$(basename "$source_file")"
			continue
		fi
		install_agent_prompt_file "$instructions_dir" "$source_file"
		found=true
	done

	if ! $found; then
		return
	fi

	# Shared discovery path used by OpenCode docs / older adapters.
	link_children "$instructions_dir" "$HOME/.agents/instructions"

	install_codex_prompts "$instructions_dir"

	local prompt_file
	for prompt_file in "$instructions_dir"/*.md; do
		[[ -f "$prompt_file" ]] || continue
		install_claude_prompt "$prompt_file"
		install_opencode_prompt "$prompt_file"
		install_grok_prompt "$prompt_file"
	done
}

# ─── OpenCode: TypeScript Plugins ────────────────────────────────────────────

DEPRECATED_PLUGINS=(
	"version-check.ts"
	"dprint-autoformat.ts"
	"kubectl-safety.ts"
	"kubectl-enforcer.ts"
	"git-enforcer.ts"
)

cleanup_deprecated_plugins() {
	local plugins_dir="$1"
	for old_name in "${DEPRECATED_PLUGINS[@]}"; do
		if [[ -f "$plugins_dir/$old_name" ]]; then
			echo "[opencode] Removing deprecated: $old_name"
			rm "$plugins_dir/$old_name"
		fi
	done
}

install_opencode_plugins() {
	local plugins_dir="$1"
	mkdir -p "$plugins_dir"

	cleanup_deprecated_plugins "$plugins_dir"

	for plugin_file in "$REPO_DIR"/plugins/*.ts; do
		[[ -f "$plugin_file" ]] || continue
		local name
		name="$(basename "$plugin_file")"

		if [[ -f "$plugins_dir/$name" ]]; then
			echo "[opencode] Updating plugin: $name"
		else
			echo "[opencode] Installing plugin: $name"
		fi

		cp "$plugin_file" "$plugins_dir/$name"
	done
}

# ─── Claude Code: Bash Hook Scripts ──────────────────────────────────────────

# fail-closed-hook counts as review: its only wiring is as review-police's supervisor.
review_hook() {
	case "$1" in
	review-police.sh | fail-closed-hook.sh) return 0 ;;
	esac
	return 1
}

# Install hook scripts into the shared root (canon), then optionally symlink
# each into a client hooks dir (e.g. ~/.claude/hooks) so settings.json paths
# keep working without a second full copy.
install_claude_hooks() {
	local hooks_dir="$1"
	local settings_file="$2"
	local canon_dir="${3:-}"
	mkdir -p "$hooks_dir"

	local install_dir="$hooks_dir"
	if [[ -n "$canon_dir" ]]; then
		mkdir -p "$canon_dir"
		install_dir="$canon_dir"
	fi

	# Copy hook scripts into the install (canonical) dir
	for hook_file in "$REPO_DIR"/hooks/claude/*.sh; do
		[[ -f "$hook_file" ]] || continue
		local name
		name="$(basename "$hook_file")"

		# A removed script with a surviving settings.json entry would fail-closed
		# DENY every Bash call — the settings merge below strips entries in the
		# same run. Without jq that merge cannot run, so the scripts must stay
		# until it can: they live and die together.
		if review_hook "$name" && ! group_selected strict-review; then
			if command -v jq &>/dev/null; then
				if [[ -e "$install_dir/$name" || -L "$install_dir/$name" ]]; then
					echo "[claude] Removing hook (strict-review group not selected): $name"
					rm -f "$install_dir/$name"
				fi
				if [[ "$hooks_dir" != "$install_dir" && (-e "$hooks_dir/$name" || -L "$hooks_dir/$name") ]]; then
					rm -f "$hooks_dir/$name"
				fi
				continue
			fi
			if [[ ! -e "$install_dir/$name" && ! -L "$install_dir/$name" ]]; then
				continue
			fi
			echo "[claude] WARNING: jq missing — keeping $name so its settings.json entries stay functional." >&2
		fi

		if [[ -f "$install_dir/$name" && ! -L "$install_dir/$name" ]]; then
			echo "[claude] Updating hook: $name"
		else
			echo "[claude] Installing hook: $name"
		fi

		# Drop a stale symlink before writing the real script into canon.
		[[ -L "$install_dir/$name" ]] && rm -f "$install_dir/$name"
		cp "$hook_file" "$install_dir/$name"
		chmod +x "$install_dir/$name"
	done

	# Shared helpers (Claude + Grok dual payload). Real files live in the
	# install (canon) dir. Client dirs get lib/ via the top-level
	# link_children below as a *directory* symlink — never re-link files
	# inside lib/, or path resolution turns into self-symlinks.
	if [[ -d "$REPO_DIR/hooks/claude/lib" ]]; then
		# Other toolkits (e.g. OMC) install their own helpers into this dir
		# through the client-dir symlink — copy agentkit's files over, never
		# wipe the dir. A retired agentkit helper must be removed by name here.
		if [[ -L "$install_dir/lib" && ! -e "$install_dir/lib" ]]; then
			rm -f "$install_dir/lib"
		fi
		mkdir -p "$install_dir/lib"
		# Fold a pre-shared-root real client lib/ into canon before
		# link_children swaps the directory for a symlink and loses it.
		if [[ "$hooks_dir" != "$install_dir" && -d "$hooks_dir/lib" && ! -L "$hooks_dir/lib" ]]; then
			cp -a "$hooks_dir/lib/." "$install_dir/lib/"
			rm -rf "${hooks_dir:?}/lib"
		fi
		# rm by name first: a read-only or self-symlinked leftover aborts cp under set -e.
		local lib_file
		for lib_file in "$REPO_DIR"/hooks/claude/lib/*; do
			rm -f "$install_dir/lib/$(basename "$lib_file")"
		done
		cp -a "$REPO_DIR"/hooks/claude/lib/. "$install_dir/lib/"
		echo "[claude] Installed hook lib/ helpers"
	fi

	if [[ -n "$canon_dir" && "$hooks_dir" != "$canon_dir" ]]; then
		link_children "$canon_dir" "$hooks_dir"
	fi

	# Merge hooks into settings.json — commands still resolve under hooks_dir
	# (symlinks to canon), matching historical $HOME/.claude/hooks paths.
	merge_claude_settings "$settings_file" "$hooks_dir"
}

merge_claude_settings() {
	local settings_file="$1"
	local hooks_dir="$2"

	# Check if jq is available
	if ! command -v jq &>/dev/null; then
		echo "[claude] WARNING: jq not found. Cannot merge hooks into settings.json."
		echo "[claude] Install jq and re-run, or manually copy hooks config from:"
		echo "         $REPO_DIR/hooks/claude/settings.json"
		return
	fi

	# Derived from the canonical wiring, never a second copy of it. A duplicate
	# list here silently drifts: review-police was wired in settings.json for
	# months and never installed, so the merge gate was inert on every machine
	# that used this installer.
	local canonical="$REPO_DIR/hooks/claude/settings.json"
	if [[ ! -f "$canonical" ]]; then
		echo "[claude] ERROR: missing $canonical — cannot wire hooks." >&2
		return 1
	fi
	# The merge below replaces the whole hooks section, so filtering review
	# entries here both withholds them on fresh installs and strips previously
	# merged ones on upgrade — the settings side of removing the scripts above.
	local review_selected=true
	group_selected strict-review || review_selected=false

	local hooks_json
	hooks_json=$(jq --arg dir "$hooks_dir" --argjson review "$review_selected" '
    {hooks: (.hooks | with_entries(
      .value |= (map(.hooks |= map(
        select($review or ((.command // "") | contains("review-police") | not))
        | .command |= gsub("\\$HOME/\\.claude/hooks"; $dir)
      )) | map(select((.hooks | length) > 0)))
    ))}
  ' "$canonical")

	if [[ -f "$settings_file" ]]; then
		# Merge: existing settings + our hooks (our hooks win on conflict)
		local existing
		existing=$(cat "$settings_file")

		# Check if it already has hooks
		if echo "$existing" | jq -e '.hooks.PreToolUse' &>/dev/null; then
			echo "[claude] Replacing existing hooks in: $settings_file"
		else
			echo "[claude] Adding hooks to existing: $settings_file"
		fi

		# Deep merge: keep existing keys, overlay our hooks
		echo "$existing" | jq --argjson new_hooks "$hooks_json" '. * $new_hooks' >"${settings_file}.tmp"
		mv "${settings_file}.tmp" "$settings_file"
	else
		# Create new settings file with just hooks
		mkdir -p "$(dirname "$settings_file")"
		echo "$hooks_json" | jq '.' >"$settings_file"
		echo "[claude] Created: $settings_file"
	fi
}

# ─── Codex CLI: Review Gate Hook ────────────────────────────────────────────

merge_codex_hooks() {
	local hooks_file="$1"
	local hooks_dir="$2"
	local canonical="$REPO_DIR/hooks/codex/hooks.json"

	if ! command -v jq >/dev/null 2>&1; then
		echo "[codex] ERROR: jq is required to merge the review hook into $hooks_file" >&2
		return 1
	fi
	if [[ ! -f "$canonical" ]]; then
		echo "[codex] ERROR: missing $canonical — cannot wire the review gate." >&2
		return 1
	fi

	local rendered
	rendered=$(jq --arg token '__AGENTKIT_CODEX_HOOKS_ROOT__' --arg root "$hooks_dir" '
    ($root | @sh) as $quoted_root
    | walk(if type == "string" then gsub($token; $quoted_root) else . end)
  ' "$canonical") || return 1

	mkdir -p "$(dirname "$hooks_file")"
	if [[ -f "$hooks_file" ]]; then
		jq -e 'type == "object" and ((.hooks // {}) | type == "object")' \
			"$hooks_file" >/dev/null 2>&1 || {
			echo "[codex] ERROR: existing hooks file is malformed: $hooks_file" >&2
			return 1
		}
		jq --argjson agentkit "$rendered" '
      def without_agentkit:
        map(
          .hooks = ((.hooks // []) |
            map(select(((.command // "") | contains("AGENTKIT_HOOK_TARGET=codex")) | not)))
          | select((.hooks | length) > 0)
        );
      .hooks = (.hooks // {})
      | .hooks.PreToolUse = (
          ((.hooks.PreToolUse // []) | without_agentkit)
          + $agentkit.hooks.PreToolUse
        )
    ' "$hooks_file" >"${hooks_file}.tmp" || return 1
		mv "${hooks_file}.tmp" "$hooks_file"
		echo "[codex] Updated review hooks: $hooks_file"
	else
		printf '%s\n' "$rendered" >"$hooks_file"
		echo "[codex] Created review hooks: $hooks_file"
	fi
}

install_codex_review_hooks() {
	local codex_dir="$1"
	local hooks_dir="$codex_dir/hooks"
	local tools_dir="$codex_dir/tools"
	local hook_name source tool_name

	if ! command -v jq >/dev/null 2>&1; then
		echo "[codex] ERROR: jq is required to install the Codex review hook." >&2
		return 1
	fi

	mkdir -p "$hooks_dir/lib" "$tools_dir"
	hooks_dir=$(cd "$hooks_dir" && pwd -P)
	tools_dir=$(cd "$tools_dir" && pwd -P)

	for hook_name in fail-closed-hook.sh review-police.sh; do
		source="$REPO_DIR/hooks/claude/$hook_name"
		if [[ ! -f "$source" ]]; then
			echo "[codex] ERROR: missing review hook: $source" >&2
			return 1
		fi
		cp "$source" "$hooks_dir/$hook_name"
		chmod +x "$hooks_dir/$hook_name"
	done
	if [[ ! -f "$REPO_DIR/hooks/claude/lib/hook-input.sh" ]]; then
		echo "[codex] ERROR: missing review hook input helper." >&2
		return 1
	fi
	cp "$REPO_DIR/hooks/claude/lib/hook-input.sh" "$hooks_dir/lib/hook-input.sh"
	for tool_name in review-gate review-profile; do
		source="$REPO_DIR/tools/$tool_name"
		if [[ ! -f "$source" ]]; then
			echo "[codex] ERROR: missing review tool: $tool_name" >&2
			return 1
		fi
		cp "$source" "$tools_dir/$tool_name"
		chmod +x "$tools_dir/$tool_name"
	done

	merge_codex_hooks "$codex_dir/hooks.json" "$hooks_dir"
	echo "[codex] Review or re-trust the AgentKit hooks with /hooks in a new Codex session."
}

remove_codex_review_hooks() {
	local codex_dir="$1"
	local hooks_file="$codex_dir/hooks.json"
	local name removed=false

	# Scripts and their hooks.json entries live and die together; without jq
	# the entries cannot be stripped, so nothing may be deleted.
	if [[ -f "$hooks_file" ]] && ! command -v jq >/dev/null 2>&1; then
		echo "[codex] WARNING: jq missing — leaving review hooks installed so hooks.json stays functional." >&2
		return 0
	fi

	for name in fail-closed-hook.sh review-police.sh; do
		if [[ -e "$codex_dir/hooks/$name" ]]; then
			rm -f "$codex_dir/hooks/$name"
			removed=true
		fi
	done
	rm -f "$codex_dir/hooks/lib/hook-input.sh"
	for name in review-gate review-profile; do
		if [[ -e "$codex_dir/tools/$name" ]]; then
			rm -f "$codex_dir/tools/$name"
			removed=true
		fi
	done

	if [[ -f "$hooks_file" ]] && command -v jq >/dev/null 2>&1; then
		if jq -e '(.hooks.PreToolUse // []) | map(.hooks // []) | flatten
		          | any(.command // "" | contains("AGENTKIT_HOOK_TARGET=codex"))' \
			"$hooks_file" >/dev/null 2>&1; then
			jq '
        .hooks.PreToolUse = ((.hooks.PreToolUse // []) |
          map(
            .hooks = ((.hooks // []) |
              map(select(((.command // "") | contains("AGENTKIT_HOOK_TARGET=codex")) | not)))
            | select((.hooks | length) > 0)
          ))
      ' "$hooks_file" >"${hooks_file}.tmp" && mv "${hooks_file}.tmp" "$hooks_file"
			removed=true
		fi
	fi

	if [[ "$removed" == true ]]; then
		echo "[codex] Removed review gate hooks (strict-review group not selected)."
	fi
}

# ─── Per-Session Resource Shims ──────────────────────────────────────────────

readonly SESSION_RUNTIMES=(claude codex opencode grok)

install_session_shims() {
	local shim_dir="$1"
	local tools_dir="$2"
	local created=0

	if [[ ! -x "$tools_dir/agent-session" ]]; then
		echo "[shims] Skipped: agent-session not installed"
		return 0
	fi

	mkdir -p "$shim_dir"

	local runtime real
	for runtime in "${SESSION_RUNTIMES[@]}"; do
		# Without dropping the shim dir, a re-install resolves its own shim.
		real="$(PATH="$(path_without "$shim_dir")" command -v "$runtime" 2>/dev/null || true)"
		if [[ -z "$real" ]]; then
			[[ -L "$shim_dir/$runtime" ]] && rm -f "$shim_dir/$runtime"
			continue
		fi

		ln -sf "$tools_dir/agent-session" "$shim_dir/$runtime"
		echo "[shims] Scoping: $runtime -> $real"
		created=$((created + 1))
	done

	if [[ "$created" -eq 0 ]]; then
		echo "[shims] No supported agent runtimes found on PATH"
	fi
}

# Per-session scopes bound one session; this bounds all of them together. Base
# unit only — operator overrides belong in agent-sessions.slice.d/ drop-ins,
# which systemd layers on top and a re-install will not clobber.
install_session_slice() {
	local unit_dir="$1"
	local unit="$unit_dir/agent-sessions.slice"

	mkdir -p "$unit_dir"
	cat >"$unit" <<-'SLICE'
		# Managed by agentkit install.sh. Override via agent-sessions.slice.d/.
		[Unit]
		Description=Aggregate resource guard for interactive agent CLI sessions

		[Slice]
		CPUQuota=1600%
		MemoryHigh=24G
		MemoryMax=32G
		MemorySwapMax=4G
		TasksMax=24576
	SLICE
	echo "[shims] Aggregate slice: $unit"

	if user_bus_env; then
		systemctl --user daemon-reload || true
		echo "[shims] Reloaded user systemd manager"
	else
		echo "[shims] User systemd manager unavailable; slice applies at next login"
	fi
}

# Terminals spawned by a service manager (code-server, CI) inherit neither of
# these, so the reload silently deferred to next login — leaving the slice
# unapplied exactly when it is needed. Same fix agent-session already makes.
user_bus_env() {
	local runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
	[[ -e "$runtime_dir/bus" ]] || return 1

	export XDG_RUNTIME_DIR="$runtime_dir"
	export DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_dir/bus"
	systemctl --user show-environment > /dev/null 2>&1
}

path_without() {
	local drop="$1"
	local entry out=""
	local saved_ifs="$IFS"
	IFS=:
	# shellcheck disable=SC2086
	set -- $PATH
	IFS="$saved_ifs"

	for entry in "$@"; do
		[[ -n "$entry" ]] || continue
		[[ "$entry" == "$drop" ]] && continue
		out="${out:+$out:}$entry"
	done
	printf '%s' "$out"
}

# Markers keep repeated installs idempotent and the block cleanly removable.
install_shim_path() {
	local shim_dir="$1"
	local rc_file="$2"
	local begin="# >>> agentkit session shims >>>"
	local end="# <<< agentkit session shims <<<"

	if [[ -f "$rc_file" ]] && grep -Fq "$begin" "$rc_file"; then
		echo "[shims] PATH entry already present in $rc_file"
		return 0
	fi

	{
		printf '\n%s\n' "$begin"
		printf '# Runs each agent CLI session in its own systemd scope.\n'
		# $PATH stays unexpanded on purpose: what lands in the rc file has to be
		# read at the reader's shell startup, not resolved to the installer's
		# PATH and frozen there.
		# shellcheck disable=SC2016
		printf 'case ":$PATH:" in\n'
		printf '  *":%s:"*) ;;\n' "$shim_dir"
		# shellcheck disable=SC2016
		printf '  *) PATH="%s:$PATH" ;;\n' "$shim_dir"
		printf 'esac\n'
		printf '%s\n' "$end"
	} >>"$rc_file"

	echo "[shims] Added PATH entry to $rc_file"
}

# ─── Codex CLI: Skills as Custom Prompts ─────────────────────────────────────

install_codex_skills() {
	local prompts_dir="$1"
	mkdir -p "$prompts_dir"

	for skill_dir in "$REPO_DIR"/skills/*/; do
		local name target group
		name="$(basename "$skill_dir")"
		[[ -f "$skill_dir/SKILL.md" ]] || continue
		target="$prompts_dir/$name.md"
		group="$(skill_group "$name")"

		if ! group_selected "$group"; then
			if group_explicit "$group"; then
				if [[ -f "$target" ]]; then
					echo "[codex] Removing prompt (explicit group '$group' not selected): $name.md"
					rm -f "$target"
				fi
				continue
			fi
			if [[ ! -f "$target" ]]; then
				echo "[codex] Skipping prompt (group '$group' — add --with $group): $name.md"
				continue
			fi
		fi

		if [[ -f "$target" ]]; then
			echo "[codex] Updating prompt: $name.md"
		else
			echo "[codex] Installing prompt: $name.md"
		fi

		# Codex prompts are plain markdown invoked as /<name> — strip the
		# SKILL.md YAML frontmatter, keep the body verbatim.
		awk 'NR==1 && /^---[[:space:]]*$/ {infm=1; next} infm && /^---[[:space:]]*$/ {infm=0; next} !infm {print}' \
			"$skill_dir/SKILL.md" >"$target"
	done
}

# ─── Claude Code: Plugin-Mode Install ────────────────────────────────────────

plugin_is_installed() {
	printf '%s' "$2" |
		jq -e --arg id "$1" '.[] | select(.id == $id and .scope == "user")' >/dev/null
}

# An unselected group whose plugin is already installed is still updated — the
# plugin-mode counterpart of keeping an already-installed skill.
claude_plugin_targets() {
	local installed="$1" group id
	for group in $(declared_groups); do
		id="$(group_plugin_id "$group")@agentkit"
		if group_selected "$group" || plugin_is_installed "$id" "$installed"; then
			printf '%s\n' "$id"
		fi
	done
}

ensure_claude_plugin() {
	local id="$1" installed="$2"
	if plugin_is_installed "$id" "$installed"; then
		echo "[claude] Updating plugin: $id"
		if ! claude plugin update "$id"; then
			echo "[claude] ERROR: failed to update $id." >&2
			return 1
		fi
	else
		echo "[claude] Installing plugin: $id"
		if ! claude plugin install "$id"; then
			echo "[claude] ERROR: failed to install $id." >&2
			return 1
		fi
	fi
}

install_claude_plugin() {
	if ! command -v claude &>/dev/null; then
		echo "[claude] WARNING: claude CLI not found — cannot install the plugin."
		return 1
	fi

	echo "[claude] Registering marketplace: $REPO_DIR"
	if ! claude plugin marketplace add "$REPO_DIR" 2>/dev/null; then
		if ! claude plugin marketplace update agentkit; then
			echo "[claude] ERROR: failed to register the agentkit marketplace." >&2
			return 1
		fi
	fi

	if ! command -v jq &>/dev/null; then
		echo "[claude] ERROR: jq is required to inspect the installed plugin state." >&2
		return 1
	fi

	local installed_plugins
	if ! installed_plugins="$(claude plugin list --json)"; then
		echo "[claude] ERROR: could not inspect installed Claude plugins." >&2
		return 1
	fi
	if ! printf '%s' "$installed_plugins" | jq -e 'type == "array"' >/dev/null 2>&1; then
		echo "[claude] ERROR: claude plugin list returned malformed JSON." >&2
		return 1
	fi

	local targets plugin_id
	targets="$(claude_plugin_targets "$installed_plugins")"
	for plugin_id in $targets; do
		ensure_claude_plugin "$plugin_id" "$installed_plugins" || return 1
	done

	local ready_plugins
	if ! ready_plugins="$(claude plugin list --json)"; then
		echo "[claude] ERROR: could not verify the installed Claude plugin." >&2
		return 1
	fi
	if ! printf '%s' "$ready_plugins" | jq -e 'type == "array"' >/dev/null 2>&1; then
		echo "[claude] ERROR: post-install plugin state was malformed." >&2
		return 1
	fi
	for plugin_id in $targets; do
		if ! printf '%s' "$ready_plugins" | jq -e --arg id "$plugin_id" \
			'.[] | select(.id == $id and .scope == "user" and .enabled == true)' >/dev/null; then
			echo "[claude] ERROR: $plugin_id is not enabled after installation or update." >&2
			return 1
		fi
	done

	# A leftover manual install would run every hook twice (settings.json +
	# the plugin's hooks.json) — warn loudly, never edit user settings.
	local settings_file="$HOME/.claude/settings.json"
	if [[ -f "$settings_file" ]] && grep -Fq "git-police.sh" "$settings_file"; then
		echo "[claude] WARNING: manually-installed agentkit hooks found in $settings_file."
		echo "[claude] Remove that hooks section to avoid double execution alongside the plugin."
	fi
	local d
	for d in "$REPO_DIR"/skills/*/; do
		if [[ -d "$HOME/.claude/skills/$(basename "$d")" ]]; then
			echo "[claude] NOTE: manually-installed agentkit skills present in ~/.claude/skills/ — remove them in plugin mode to avoid duplicate listings."
			break
		fi
	done

	echo "[claude] Plugin ready — restart Claude Code to load it."
}

# ─── User Config (~/.config/agentkit/) ───────────────────────────────────────

install_config() {
	local config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit"
	local config_file="$config_dir/config.yaml"
	mkdir -p "$config_dir"

	if [[ -f "$config_file" ]]; then
		echo "[config] Existing config preserved: $config_file"
	else
		cp "$REPO_DIR/config.example.yaml" "$config_file"
		echo "[config] Created default config: $config_file"
		echo "[config] Edit to customize: $config_file"
	fi
}

# ─── Main: Global Install ────────────────────────────────────────────────────

if [[ "$GLOBAL" == true ]]; then
	echo "Installing agentkit globally (all tools)"
	echo "Shared root: $AGENTKIT_HOME"
	echo ""

	# ── Config ──
	echo "--- Config ---"
	install_config
	write_persisted_groups
	echo "[groups] Selected: $SELECTED_GROUPS ($GROUPS_STATE_FILE)"
	echo ""

	# ── Shared content root (single copy) ──
	SKILLS_CANON="$AGENTKIT_HOME/skills"
	RULES_CANON="$AGENTKIT_HOME/rules"
	HOOKS_CANON="$AGENTKIT_HOME/hooks"
	TOOLS_CANON="$AGENTKIT_HOME/tools"
	INSTRUCTIONS_CANON="$AGENTKIT_HOME/instructions"

	echo "--- Skills (SKILL.md → $SKILLS_CANON) ---"
	install_skills "$SKILLS_CANON"
	echo ""

	echo "--- Rules → $RULES_CANON ---"
	install_rules "$RULES_CANON"
	echo ""

	echo "--- Global agent prompt → $INSTRUCTIONS_CANON ---"
	install_global_agent_prompt "$INSTRUCTIONS_CANON"
	echo ""

	# Client skill/rule adapters — per-name symlinks only (leave OMC / Grok
	# builtins sitting next to them).
	echo "--- Client skill links ---"
	link_children "$SKILLS_CANON" \
		"$HOME/.agents/skills" \
		"$HOME/.claude/skills" \
		"$HOME/.grok/skills"
	prune_dangling_links "$HOME/.agents/skills"
	prune_dangling_links "$HOME/.claude/skills"
	prune_dangling_links "$HOME/.grok/skills"
	# A real directory under a client skills dir has no agentkit provenance —
	# it may be the user's own fork, so removal only gets a loud warning.
	for skill_dir in "$REPO_DIR"/skills/*/; do
		skill_name="$(basename "$skill_dir")"
		skill_group_name="$(skill_group "$skill_name")"
		if group_explicit "$skill_group_name" && ! group_selected "$skill_group_name"; then
			for client_skills in "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.grok/skills"; do
				if [[ -e "$client_skills/$skill_name" && ! -L "$client_skills/$skill_name" ]]; then
					echo "[skills] WARNING: leaving $client_skills/$skill_name in place (not installed by this installer); remove it manually if unwanted." >&2
				fi
			done
		fi
	done
	echo ""

	echo "--- Client rule links ---"
	link_children "$RULES_CANON" \
		"$HOME/.agents/rules" \
		"$HOME/.claude/rules" \
		"$HOME/.grok/rules"
	echo ""

	# ── OpenCode ──
	OPENCODE_PLUGINS="$HOME/.config/opencode/plugins"
	echo "--- OpenCode (TypeScript plugins) ---"
	install_opencode_plugins "$OPENCODE_PLUGINS"
	echo ""

	# ── Claude Code ──
	CLAUDE_HOOKS="$HOME/.claude/hooks"
	CLAUDE_TOOLS="$HOME/.claude/tools"
	PATH_TOOLS="$HOME/.local/bin"
	CLAUDE_SKILLS="$HOME/.claude/skills"
	CLAUDE_SETTINGS="$HOME/.claude/settings.json"
	if [[ "$CLAUDE_PLUGIN" == true ]]; then
		install_claude_plugin
		CLAUDE_MODE="plugin (one per selected group: $SELECTED_GROUPS)"
		echo ""
	else
		CLAUDE_MODE="manual (hooks via $CLAUDE_HOOKS → $HOOKS_CANON, settings $CLAUDE_SETTINGS)"
		echo "--- Claude Code (bash hooks, shared root) ---"
		install_claude_hooks "$CLAUDE_HOOKS" "$CLAUDE_SETTINGS" "$HOOKS_CANON"
		echo ""
	fi
	echo "--- Standalone tools ---"
	install_tools "$PATH_TOOLS"
	install_tools "$TOOLS_CANON"
	# Claude tools dir: per-tool symlinks into the shared tools root (not a
	# second full copy). Keep ~/.local/bin as real files for PATH.
	link_children "$TOOLS_CANON" "$CLAUDE_TOOLS"
	reconcile_tool_links "$CLAUDE_TOOLS"
	prune_dangling_links "$CLAUDE_TOOLS"
	echo ""

	# ── Per-session resource scoping ──
	SESSION_SHIMS="${XDG_DATA_HOME:-$HOME/.local/share}/agentkit/shims"
	if [[ "$SESSION_SCOPE" == true ]]; then
		echo "--- Per-session resource scoping ---"
		install_session_shims "$SESSION_SHIMS" "$PATH_TOOLS"
		install_session_slice "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
		install_shim_path "$SESSION_SHIMS" "$HOME/.bashrc"
		echo ""
	fi

	# ── Codex CLI ──
	CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
	CODEX_RULES="$CODEX_ROOT/rules"
	CODEX_PROMPTS="$CODEX_ROOT/prompts"
	echo "--- Codex CLI (review gate hook) ---"
	if group_selected strict-review; then
		install_codex_review_hooks "$CODEX_ROOT"
	else
		remove_codex_review_hooks "$CODEX_ROOT"
	fi
	echo ""
	echo "--- Codex CLI (Starlark policies) ---"
	install_codex_policies "$CODEX_RULES"
	echo ""
	echo "--- Codex CLI (skills as prompts) ---"
	install_codex_skills "$CODEX_PROMPTS"
	echo ""

	# ── Summary ──
	echo "Done. Installed globally for all tools:"
	echo ""
	echo "  Shared root:     $AGENTKIT_HOME/{skills,rules,instructions,hooks,tools}"
	echo "  Skill groups:    $SELECTED_GROUPS"
	echo "  Config:          ${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"
	echo "  Prompts:         $INSTRUCTIONS_CANON/*.md"
	echo "  Skills links:    ~/.agents/skills, ~/.claude/skills, ~/.grok/skills"
	echo "  Rules links:     ~/.agents/rules, ~/.claude/rules, ~/.grok/rules"
	echo "  OpenCode:        $OPENCODE_PLUGINS/ (auto-loaded)"
	echo "  Claude Code:     $CLAUDE_MODE"
	echo "  Grok CLI:        skills+rules links; instructions in ~/.grok/rules/"
	echo "  PATH tools:      $PATH_TOOLS/"
	[[ "$SESSION_SCOPE" == true ]] && echo "  Session shims:   $SESSION_SHIMS/ (prepended to PATH in ~/.bashrc)"
	echo "  Claude tools:    $CLAUDE_TOOLS/ → $TOOLS_CANON/"
	echo "  Codex CLI:       $CODEX_RULES/ (policies), $CODEX_PROMPTS/ (prompts), $CODEX_ROOT/hooks.json"

# ─── Main: Project Install ───────────────────────────────────────────────────

else
	TARGET_DIR="${TARGET_DIR:-.}"
	TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

	echo "Installing agentkit into: $TARGET_DIR"
	echo ""

	# ── Skills (shared) ──
	SKILLS_DEST="$TARGET_DIR/.opencode/skills"
	echo "--- Skills (SKILL.md) ---"
	install_skills "$SKILLS_DEST"
	echo ""

	# ── Rules (shared) ──
	RULES_DEST="$TARGET_DIR/.opencode/rules"
	echo "--- Rules (auto-loaded by glob) ---"
	install_rules "$RULES_DEST"
	echo ""

	# ── OpenCode ──
	OPENCODE_PLUGINS="$TARGET_DIR/.opencode/plugins"
	echo "--- OpenCode (TypeScript plugins) ---"
	install_opencode_plugins "$OPENCODE_PLUGINS"
	echo ""

	# ── Claude Code ──
	CLAUDE_HOOKS="$TARGET_DIR/.claude/hooks"
	CLAUDE_TOOLS="$TARGET_DIR/.claude/tools"
	CLAUDE_SKILLS="$TARGET_DIR/.claude/skills"
	CLAUDE_SETTINGS="$TARGET_DIR/.claude/settings.json"
	echo "--- Claude Code (bash hooks) ---"
	install_claude_hooks "$CLAUDE_HOOKS" "$CLAUDE_SETTINGS"
	echo ""
	echo "--- Claude Code (skills) ---"
	install_skills "$CLAUDE_SKILLS"
	echo ""
	echo "--- Standalone tools ---"
	install_tools "$CLAUDE_TOOLS"
	echo ""

	# ── Codex CLI ──
	CODEX_ROOT="$TARGET_DIR/.codex"
	CODEX_RULES="$CODEX_ROOT/rules"
	echo "--- Codex CLI (review gate hook) ---"
	if group_selected strict-review; then
		install_codex_review_hooks "$CODEX_ROOT"
	else
		remove_codex_review_hooks "$CODEX_ROOT"
	fi
	echo ""
	echo "--- Codex CLI (Starlark policies) ---"
	install_codex_policies "$CODEX_RULES"
	echo ""

	# ── Summary ──
	echo "Done. Installed into $TARGET_DIR for all tools:"
	echo ""
	echo "  Skills:      $SKILLS_DEST/ (OpenCode), $CLAUDE_SKILLS/ (Claude Code)"
	echo "  Skill groups: $SELECTED_GROUPS"
	echo "  Rules:       $RULES_DEST/"
	echo "  OpenCode:    $OPENCODE_PLUGINS/"
	echo "  Claude Code: $CLAUDE_HOOKS/ (hooks in $CLAUDE_SETTINGS)"
	echo "  Tools:       $CLAUDE_TOOLS/"
	echo "  Codex CLI:   $CODEX_RULES/, $CODEX_ROOT/hooks.json"
	echo ""
	echo "Verify with:"
	echo "  ls $SKILLS_DEST/"
	echo "  ls $CLAUDE_SKILLS/"
	echo "  ls $OPENCODE_PLUGINS/"
	echo "  ls $CLAUDE_HOOKS/"
	echo "  ls $CLAUDE_TOOLS/"
	echo "  ls $CODEX_RULES/"
fi
