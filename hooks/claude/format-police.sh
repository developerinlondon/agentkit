#!/usr/bin/env bash
# format-police.sh — Claude Code PostToolUse hook (matcher: Edit|Write)
# Auto-formats files after edit/write using dprint
# Equivalent to: plugins/format-police.ts (OpenCode)
set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only trigger on Edit or Write tools
case "$TOOL_NAME" in
  Edit|Write|edit|write) ;;
  *) exit 0 ;;
esac

# Extract the file path from tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')
[[ -z "$FILE_PATH" ]] && exit 0

# Only format known file types
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.jsonc|*.md|*.yaml|*.yml|*.toml|*.css|*.html) ;;
  *) exit 0 ;;
esac

# Find dprint binary
DPRINT=""
if command -v dprint &>/dev/null; then
  DPRINT="dprint"
else
  # Check mise-managed installs
  MISE_DIR="$HOME/.local/share/mise/installs/dprint"
  if [[ -d "$MISE_DIR" ]]; then
    LATEST=$(ls -1 "$MISE_DIR" 2>/dev/null | sort -V | tail -1)
    if [[ -n "$LATEST" && -x "$MISE_DIR/$LATEST/dprint" ]]; then
      DPRINT="$MISE_DIR/$LATEST/dprint"
    fi
  fi
fi

if [[ -z "$DPRINT" ]]; then
  exit 0  # dprint not found, silently skip
fi

# Format the file (ignore failures — don't block the tool)
"$DPRINT" fmt "$FILE_PATH" 2>/dev/null || true

exit 0
