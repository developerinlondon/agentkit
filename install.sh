#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=false
TARGET_DIR=""

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options] [target-project-dir]

Installs agent-skills into a project or globally.

Options:
  --global             Install skills to ~/.agents/skills/ (available in all projects)
  target-project-dir   Project directory to install into (default: current dir)

Examples:
  ./install.sh --global               # Install skills globally
  ./install.sh                        # Install into current project (.opencode/skills/)
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

install_plugins() {
  local plugins_dir="$1/.opencode/plugins"
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

if [[ "$GLOBAL" == true ]]; then
  DEST="$HOME/.agents/skills"
  echo "Installing skills globally to: $DEST"
  echo ""
  echo "--- Skills (SKILL.md) ---"
  install_skills "$DEST"
  echo ""
  echo "Done. Skills available globally via ~/.agents/skills/"
  echo "  OpenCode: auto-discovered"
  echo "  Claude Code: reference in ~/.claude/settings.json userInstructions"
else
  TARGET_DIR="${TARGET_DIR:-.}"
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
  DEST="$TARGET_DIR/.opencode/skills"

  echo "Installing agent-skills into: $TARGET_DIR"
  echo ""
  echo "--- Skills (SKILL.md) ---"
  install_skills "$DEST"
  echo ""
  echo "--- Plugins (OpenCode) ---"
  install_plugins "$TARGET_DIR"
  echo ""
  echo "Done. Installed into $TARGET_DIR"
  echo ""
  echo "Verify with:"
  echo "  ls $DEST/"
  echo "  ls $TARGET_DIR/.opencode/plugins/"
fi
