#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=false
TARGET_DIR=""

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options] [target-project-dir]

Installs agent-skills (skills + plugins) into a project or globally.

Options:
  --global             Install to ~/.agents/ (skills + plugins available in all projects)
  target-project-dir   Project directory to install into (default: current dir)

Examples:
  ./install.sh --global               # Install globally (~/.agents/skills/ + ~/.agents/plugins/)
  ./install.sh                        # Install into current project (.opencode/)
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
      echo "[plugins] Removing deprecated: $old_name"
      rm "$plugins_dir/$old_name"
    fi
  done
}

install_plugins() {
  local plugins_dir="$1"
  mkdir -p "$plugins_dir"

  cleanup_deprecated_plugins "$plugins_dir"

  for plugin_file in "$REPO_DIR"/plugins/*.ts; do
    [[ -f "$plugin_file" ]] || continue
    local name
    name="$(basename "$plugin_file")"

    if [[ -f "$plugins_dir/$name" ]]; then
      echo "[plugins] Updating: $name"
    else
      echo "[plugins] Installing: $name"
    fi

    cp "$plugin_file" "$plugins_dir/$name"
  done
}

print_global_plugin_instructions() {
  local plugins_dir="$1"
  local config_dir="$HOME/.config/opencode"

  echo ""
  echo "[plugins] To use global plugins, add file:// entries to your opencode config plugin array:"
  echo ""
  for plugin_file in "$plugins_dir"/*.ts; do
    [[ -f "$plugin_file" ]] || continue
    echo "  \"file://$plugin_file\""
  done

  if [[ -f "$config_dir/opencode.jsonc" ]]; then
    echo ""
    echo "[plugins] Config: $config_dir/opencode.jsonc"
  elif [[ -f "$config_dir/opencode.json" ]]; then
    echo ""
    echo "[plugins] Config: $config_dir/opencode.json"
  fi
}

if [[ "$GLOBAL" == true ]]; then
  SKILLS_DEST="$HOME/.agents/skills"
  PLUGINS_DEST="$HOME/.agents/plugins"

  echo "Installing agent-skills globally"
  echo ""
  echo "--- Skills (SKILL.md) ---"
  install_skills "$SKILLS_DEST"
  echo ""
  echo "--- Plugins (OpenCode) ---"
  install_plugins "$PLUGINS_DEST"
  print_global_plugin_instructions "$PLUGINS_DEST"
  echo ""
  echo "Done."
  echo "  Skills: $SKILLS_DEST/ (auto-discovered by OpenCode)"
  echo "  Plugins: $PLUGINS_DEST/ (add file:// entries to opencode config)"
else
  TARGET_DIR="${TARGET_DIR:-.}"
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
  SKILLS_DEST="$TARGET_DIR/.opencode/skills"
  PLUGINS_DEST="$TARGET_DIR/.opencode/plugins"

  echo "Installing agent-skills into: $TARGET_DIR"
  echo ""
  echo "--- Skills (SKILL.md) ---"
  install_skills "$SKILLS_DEST"
  echo ""
  echo "--- Plugins (OpenCode) ---"
  install_plugins "$PLUGINS_DEST"
  echo ""
  echo "Done. Installed into $TARGET_DIR"
  echo ""
  echo "Verify with:"
  echo "  ls $SKILLS_DEST/"
  echo "  ls $PLUGINS_DEST/"
fi
