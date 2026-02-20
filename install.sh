#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=false
TARGET_DIR=""

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options] [target-project-dir]

Installs agent-skills (skills + rules + plugins + hooks + policies) for all
supported AI coding tools: OpenCode, Claude Code, and Codex CLI.

Options:
  --global             Install globally (all tools, all projects)
  target-project-dir   Project directory to install into (default: current dir)

Global install locations:
  OpenCode:    ~/.agents/skills/, ~/.agents/plugins/, ~/.agents/rules/
  Claude Code: ~/.claude/hooks/, ~/.claude/settings.json (hooks section merged)
  Codex CLI:   ~/.codex/rules/

Project install locations:
  OpenCode:    .opencode/skills/, .opencode/plugins/, .opencode/rules/
  Claude Code: .claude/hooks/, .claude/settings.json (hooks section merged)
  Codex CLI:   .codex/rules/

Examples:
  ./install.sh --global               # Install for all tools globally
  ./install.sh                        # Install into current project
  ./install.sh ~/code/my-project      # Install into specific project
USAGE
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage ;;
    --global) GLOBAL=true ;;
    *) TARGET_DIR="$arg" ;;
  esac
done

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
    --arg format_police "$hooks_dir/format-police.sh" \
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
    echo "$existing" | jq --argjson new_hooks "$hooks_json" '. * $new_hooks' > "${settings_file}.tmp"
    mv "${settings_file}.tmp" "$settings_file"
  else
    # Create new settings file with just hooks
    mkdir -p "$(dirname "$settings_file")"
    echo "$hooks_json" | jq '.' > "$settings_file"
    echo "[claude] Created: $settings_file"
  fi
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

# ─── Main: Global Install ────────────────────────────────────────────────────

if [[ "$GLOBAL" == true ]]; then
  echo "Installing agent-skills globally (all tools)"
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
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
  echo "--- Claude Code (bash hooks) ---"
  install_claude_hooks "$CLAUDE_HOOKS" "$CLAUDE_SETTINGS"
  echo ""

  # ── Codex CLI ──
  CODEX_RULES="$HOME/.codex/rules"
  echo "--- Codex CLI (Starlark policies) ---"
  install_codex_policies "$CODEX_RULES"
  echo ""

  # ── Summary ──
  echo "Done. Installed globally for all tools:"
  echo ""
  echo "  Skills:          $SKILLS_DEST/"
  echo "  Rules:           $RULES_DEST/"
  echo "  OpenCode:        $OPENCODE_PLUGINS/ (add file:// entries to opencode config)"
  echo "  Claude Code:     $CLAUDE_HOOKS/ (hooks in $CLAUDE_SETTINGS)"
  echo "  Codex CLI:       $CODEX_RULES/ (auto-loaded at startup)"

# ─── Main: Project Install ───────────────────────────────────────────────────

else
  TARGET_DIR="${TARGET_DIR:-.}"
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

  echo "Installing agent-skills into: $TARGET_DIR"
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
  CLAUDE_SETTINGS="$TARGET_DIR/.claude/settings.json"
  echo "--- Claude Code (bash hooks) ---"
  install_claude_hooks "$CLAUDE_HOOKS" "$CLAUDE_SETTINGS"
  echo ""

  # ── Codex CLI ──
  CODEX_RULES="$TARGET_DIR/.codex/rules"
  echo "--- Codex CLI (Starlark policies) ---"
  install_codex_policies "$CODEX_RULES"
  echo ""

  # ── Summary ──
  echo "Done. Installed into $TARGET_DIR for all tools:"
  echo ""
  echo "  Skills:      $SKILLS_DEST/"
  echo "  Rules:       $RULES_DEST/"
  echo "  OpenCode:    $OPENCODE_PLUGINS/"
  echo "  Claude Code: $CLAUDE_HOOKS/ (hooks in $CLAUDE_SETTINGS)"
  echo "  Codex CLI:   $CODEX_RULES/"
  echo ""
  echo "Verify with:"
  echo "  ls $SKILLS_DEST/"
  echo "  ls $OPENCODE_PLUGINS/"
  echo "  ls $CLAUDE_HOOKS/"
  echo "  ls $CODEX_RULES/"
fi
