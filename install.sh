#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=false
TARGET_DIR=""

usage() {
	cat <<'USAGE'
Usage: ./install.sh [options] [target-project-dir]

Installs agentkit (skills + rules + plugins + hooks + tools + policies) for all
supported AI coding tools: OpenCode, Claude Code, and Codex CLI.

Options:
  --global             Install globally (all tools, all projects)
  --claude-plugin      Global only: install Claude Code bits as the agentkit
                       plugin (marketplace add + plugin install) INSTEAD of
                       copying hooks/skills and merging settings.json. The two
                       modes are mutually exclusive — plugin hooks.json on top
                       of settings.json hooks would fire every hook twice.
  target-project-dir   Project directory to install into (default: current dir)

Global install locations:
  OpenCode:    ~/.agents/skills/, ~/.agents/plugins/, ~/.agents/rules/
  Claude Code: ~/.claude/skills/, ~/.claude/hooks/, ~/.claude/tools/,
               ~/.claude/settings.json (hooks section merged)
               (--claude-plugin: agentkit plugin via marketplace instead)
  Codex CLI:   ~/.codex/rules/, ~/.codex/prompts/ (skills as /prompts)
  Executables: ~/.local/bin/ (also mirrored to ~/.claude/tools/)
  Prompts:     ~/.agents/instructions/*.md (wired into Codex/Claude/OpenCode)

Project install locations:
  OpenCode:    .opencode/skills/, .opencode/plugins/, .opencode/rules/
  Claude Code: .claude/skills/, .claude/hooks/, .claude/tools/,
               .claude/settings.json (hooks section merged)
  Codex CLI:   .codex/rules/

Examples:
  ./install.sh --global               # Install for all tools globally
  ./install.sh --global --claude-plugin  # Claude Code via plugin, rest as usual
  ./install.sh                        # Install into current project
  ./install.sh ~/code/my-project      # Install into specific project
USAGE
	exit 1
}

CLAUDE_PLUGIN=false
for arg in "$@"; do
	case "$arg" in
	-h | --help) usage ;;
	--global) GLOBAL=true ;;
	--claude-plugin) CLAUDE_PLUGIN=true ;;
	*) TARGET_DIR="$arg" ;;
	esac
done

if [[ "$CLAUDE_PLUGIN" == true && "$GLOBAL" != true ]]; then
	echo "ERROR: --claude-plugin requires --global (plugins are user-level)." >&2
	exit 1
fi

# ─── Shared: Skills ──────────────────────────────────────────────────────────

install_skills() {
	local dest="$1"
	mkdir -p "$dest"

	for skill_dir in "$REPO_DIR"/skills/*/; do
		local skill_name
		skill_name="$(basename "$skill_dir")"
		local target="$dest/$skill_name"

		if [[ -d "$target" ]]; then
			echo "[skills] Updating: $skill_name"
			rm -rf "$target"
		else
			echo "[skills] Installing: $skill_name"
		fi

		cp -r "$skill_dir" "$target"
	done
}

install_rules() {
	local dest="$1"
	mkdir -p "$dest"

	for rule_file in "$REPO_DIR"/rules/*.md; do
		[[ -f "$rule_file" ]] || continue
		local name
		name="$(basename "$rule_file")"

		if [[ -f "$dest/$name" ]]; then
			echo "[rules] Updating: $name"
		else
			echo "[rules] Installing: $name"
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
	local config_file="$HOME/.codex/config.toml"

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

install_global_agent_prompt() {
	local instructions_dir="$HOME/.agents/instructions"
	mkdir -p "$instructions_dir"

	local source_file
	local found=false
	for source_file in "$REPO_DIR"/instructions/*.md; do
		[[ -f "$source_file" ]] || continue
		install_agent_prompt_file "$instructions_dir" "$source_file"
		found=true
	done

	if ! $found; then
		return
	fi

	install_codex_prompts "$instructions_dir"

	local prompt_file
	for prompt_file in "$instructions_dir"/*.md; do
		[[ -f "$prompt_file" ]] || continue
		install_claude_prompt "$prompt_file"
		install_opencode_prompt "$prompt_file"
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

print_opencode_plugin_instructions() {
	local plugins_dir="$1"
	local config_dir="$HOME/.config/opencode"

	echo ""
	echo "[opencode] To use global plugins, add file:// entries to your opencode config plugin array:"
	echo ""
	for plugin_file in "$plugins_dir"/*.ts; do
		[[ -f "$plugin_file" ]] || continue
		echo "  \"file://$plugin_file\""
	done

	if [[ -f "$config_dir/opencode.jsonc" ]]; then
		echo ""
		echo "[opencode] Config: $config_dir/opencode.jsonc"
	elif [[ -f "$config_dir/opencode.json" ]]; then
		echo ""
		echo "[opencode] Config: $config_dir/opencode.json"
	fi
}

# ─── Claude Code: Bash Hook Scripts ──────────────────────────────────────────

install_claude_hooks() {
	local hooks_dir="$1"
	local settings_file="$2"
	mkdir -p "$hooks_dir"

	# Copy hook scripts
	for hook_file in "$REPO_DIR"/hooks/claude/*.sh; do
		[[ -f "$hook_file" ]] || continue
		local name
		name="$(basename "$hook_file")"

		if [[ -f "$hooks_dir/$name" ]]; then
			echo "[claude] Updating hook: $name"
		else
			echo "[claude] Installing hook: $name"
		fi

		cp "$hook_file" "$hooks_dir/$name"
		chmod +x "$hooks_dir/$name"
	done

	# Merge hooks into settings.json
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

	# Build the hooks JSON using the actual installed hook paths
	local hooks_json
	hooks_json=$(jq -n \
		--arg git_police "$hooks_dir/git-police.sh" \
		--arg kubectl_police "$hooks_dir/kubectl-police.sh" \
		--arg pkg_police "$hooks_dir/pkg-police.sh" \
		--arg resource_police "$hooks_dir/resource-police.sh" \
		--arg mr_police "$hooks_dir/mr-police.sh" \
		--arg format_police "$hooks_dir/format-police.sh" \
		--arg coding_police "$hooks_dir/coding-police.sh" \
		'{
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: $git_police,
                timeout: 10,
                statusMessage: "git-police: checking safety rules..."
              },
              {
                type: "command",
                command: $kubectl_police,
                timeout: 10,
                statusMessage: "kubectl-police: checking Kargo safety..."
              },
              {
                type: "command",
                command: $pkg_police,
                timeout: 10,
                statusMessage: "pkg-police: enforcing bun..."
              },
              {
                type: "command",
                command: $resource_police,
                timeout: 10,
                statusMessage: "resource-police: requiring bounded execution..."
              },
              {
                type: "command",
                command: $mr_police,
                timeout: 15,
                statusMessage: "mr-police: checking for unmerged MRs..."
              }
            ]
          }
        ],
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              {
                type: "command",
                command: $format_police,
                timeout: 15
              },
              {
                type: "command",
                command: $coding_police,
                timeout: 15
              }
            ]
          }
        ]
      }
    }')

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

# ─── Standalone Tools (Python/Bash scripts) ──────────────────────────────────

install_tools() {
	local tools_dir="$1"
	mkdir -p "$tools_dir"

	for tool_file in "$REPO_DIR"/tools/*; do
		[[ -f "$tool_file" ]] || continue
		local name
		name="$(basename "$tool_file")"

		if [[ -f "$tools_dir/$name" ]]; then
			echo "[tools] Updating: $name"
		else
			echo "[tools] Installing: $name"
		fi

		cp "$tool_file" "$tools_dir/$name"
		chmod +x "$tools_dir/$name"
	done
}

# ─── Codex CLI: Starlark .rules Files ────────────────────────────────────────

install_codex_policies() {
	local rules_dir="$1"
	mkdir -p "$rules_dir"

	for rules_file in "$REPO_DIR"/policies/codex/*.rules; do
		[[ -f "$rules_file" ]] || continue
		local name
		name="$(basename "$rules_file")"

		if [[ -f "$rules_dir/$name" ]]; then
			echo "[codex] Updating policy: $name"
		else
			echo "[codex] Installing policy: $name"
		fi

		cp "$rules_file" "$rules_dir/$name"
	done
}

# ─── Codex CLI: Skills as Custom Prompts ─────────────────────────────────────

install_codex_skills() {
	local prompts_dir="$1"
	mkdir -p "$prompts_dir"

	for skill_dir in "$REPO_DIR"/skills/*/; do
		local name target
		name="$(basename "$skill_dir")"
		[[ -f "$skill_dir/SKILL.md" ]] || continue
		target="$prompts_dir/$name.md"

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

install_claude_plugin() {
	if ! command -v claude &>/dev/null; then
		echo "[claude] WARNING: claude CLI not found — cannot install the plugin."
		return 1
	fi

	echo "[claude] Registering marketplace: $REPO_DIR"
	claude plugin marketplace add "$REPO_DIR" 2>/dev/null \
		|| claude plugin marketplace update agentkit

	echo "[claude] Installing plugin: agentkit@agentkit"
	claude plugin install agentkit@agentkit

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

	echo "[claude] Plugin installed — restart Claude Code to load it."
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
	echo ""

	# ── Config ──
	echo "--- Config ---"
	install_config
	echo ""

	# ── Global prompt ──
	echo "--- Global agent prompt ---"
	install_global_agent_prompt
	echo ""

	# ── Skills (shared) ──
	SKILLS_DEST="$HOME/.agents/skills"
	echo "--- Skills (SKILL.md) ---"
	install_skills "$SKILLS_DEST"
	echo ""

	# ── Rules (shared) ──
	RULES_DEST="$HOME/.agents/rules"
	echo "--- Rules (auto-loaded by glob) ---"
	install_rules "$RULES_DEST"
	echo ""

	# ── OpenCode ──
	OPENCODE_PLUGINS="$HOME/.agents/plugins"
	echo "--- OpenCode (TypeScript plugins) ---"
	install_opencode_plugins "$OPENCODE_PLUGINS"
	print_opencode_plugin_instructions "$OPENCODE_PLUGINS"
	echo ""

	# ── Claude Code ──
	CLAUDE_HOOKS="$HOME/.claude/hooks"
	CLAUDE_TOOLS="$HOME/.claude/tools"
	PATH_TOOLS="$HOME/.local/bin"
	CLAUDE_SKILLS="$HOME/.claude/skills"
	CLAUDE_SETTINGS="$HOME/.claude/settings.json"
	if [[ "$CLAUDE_PLUGIN" == true ]] && install_claude_plugin; then
		CLAUDE_MODE="plugin (agentkit@agentkit)"
		echo ""
	else
		[[ "$CLAUDE_PLUGIN" == true ]] && echo "[claude] Falling back to manual install."
		CLAUDE_MODE="manual ($CLAUDE_HOOKS, hooks in $CLAUDE_SETTINGS)"
		echo "--- Claude Code (bash hooks) ---"
		install_claude_hooks "$CLAUDE_HOOKS" "$CLAUDE_SETTINGS"
		echo ""
		echo "--- Claude Code (skills) ---"
		install_skills "$CLAUDE_SKILLS"
		echo ""
	fi
	echo "--- Standalone tools ---"
	install_tools "$PATH_TOOLS"
	install_tools "$CLAUDE_TOOLS"
	echo ""

	# ── Codex CLI ──
	CODEX_RULES="$HOME/.codex/rules"
	CODEX_PROMPTS="$HOME/.codex/prompts"
	echo "--- Codex CLI (Starlark policies) ---"
	install_codex_policies "$CODEX_RULES"
	echo ""
	echo "--- Codex CLI (skills as prompts) ---"
	install_codex_skills "$CODEX_PROMPTS"
	echo ""

	# ── Summary ──
	echo "Done. Installed globally for all tools:"
	echo ""
	echo "  Config:          ${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"
	echo "  Prompts:         $HOME/.agents/instructions/*.md"
	echo "  Skills:          $SKILLS_DEST/ (OpenCode), $CLAUDE_SKILLS/ (Claude Code)"
	echo "  Rules:           $RULES_DEST/"
	echo "  OpenCode:        $OPENCODE_PLUGINS/ (add file:// entries to opencode config)"
	echo "  Claude Code:     $CLAUDE_MODE"
	echo "  PATH tools:      $PATH_TOOLS/"
	echo "  Claude tools:    $CLAUDE_TOOLS/"
	echo "  Codex CLI:       $CODEX_RULES/ (auto-loaded), $CODEX_PROMPTS/ (/name prompts)"

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
	CODEX_RULES="$TARGET_DIR/.codex/rules"
	echo "--- Codex CLI (Starlark policies) ---"
	install_codex_policies "$CODEX_RULES"
	echo ""

	# ── Summary ──
	echo "Done. Installed into $TARGET_DIR for all tools:"
	echo ""
	echo "  Skills:      $SKILLS_DEST/ (OpenCode), $CLAUDE_SKILLS/ (Claude Code)"
	echo "  Rules:       $RULES_DEST/"
	echo "  OpenCode:    $OPENCODE_PLUGINS/"
	echo "  Claude Code: $CLAUDE_HOOKS/ (hooks in $CLAUDE_SETTINGS)"
	echo "  Tools:       $CLAUDE_TOOLS/"
	echo "  Codex CLI:   $CODEX_RULES/"
	echo ""
	echo "Verify with:"
	echo "  ls $SKILLS_DEST/"
	echo "  ls $CLAUDE_SKILLS/"
	echo "  ls $OPENCODE_PLUGINS/"
	echo "  ls $CLAUDE_HOOKS/"
	echo "  ls $CLAUDE_TOOLS/"
	echo "  ls $CODEX_RULES/"
fi
