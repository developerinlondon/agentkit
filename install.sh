#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-.}"

usage() {
  cat <<'USAGE'
Usage: ./install.sh [target-project-dir]

Installs agent-skills into an OpenCode project:
  1. Skills (SKILL.md) via npx skills add (if available) or direct copy
  2. Plugins (.ts) copied to .opencode/plugins/

Options:
  target-project-dir   Project directory to install into (default: current dir)

Examples:
  ./install.sh                    # Install into current project
  ./install.sh ~/code/my-project  # Install into specific project
USAGE
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

echo "Installing agent-skills into: $TARGET_DIR"
echo ""

install_skills() {
  local skills_dir="$TARGET_DIR/.opencode/skills"
  mkdir -p "$skills_dir"

  for skill_dir in "$REPO_DIR"/skills/*/; do
    local skill_name
    skill_name="$(basename "$skill_dir")"
    local target="$skills_dir/$skill_name"

    if [[ -d "$target" ]]; then
      echo "[skills] Updating: $skill_name"
      rm -rf "$target"
    else
      echo "[skills] Installing: $skill_name"
    fi

    cp -r "$skill_dir" "$target"
  done
}

install_plugins() {
  local plugins_dir="$TARGET_DIR/.opencode/plugins"
  mkdir -p "$plugins_dir"

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

echo "--- Skills (SKILL.md) ---"
install_skills

echo ""
echo "--- Plugins (OpenCode) ---"
install_plugins

echo ""
echo "Done. Installed into $TARGET_DIR"
echo ""
echo "Verify with:"
echo "  ls $TARGET_DIR/.opencode/skills/"
echo "  ls $TARGET_DIR/.opencode/plugins/"
