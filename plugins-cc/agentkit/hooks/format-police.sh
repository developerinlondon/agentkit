#!/usr/bin/env bash
# format-police.sh — Claude Code PostToolUse hook (matcher: Edit|Write)
# Auto-formats files after edit/write using dprint
# Equivalent to: plugins/format-police.ts (OpenCode)
set -euo pipefail

# Kill switch, matching the AGENTKIT_* convention used by the PreToolUse
# police. Comma-separated hook names; a blocking hook with no way off is a
# hook that eventually gets deleted instead of configured.
# Trimmed, so "a, b" behaves like "a,b" — version-police already trims, and two
# readings of one env var is a silent disagreement.
if [[ -n "${AGENTKIT_SKIP_HOOKS:-}" ]]; then
  _skip=",$(printf '%s' "$AGENTKIT_SKIP_HOOKS" | tr -d '[:space:]'),"
  case "$_skip" in
    *",format-police,"*|*",all,"*) exit 0 ;;
  esac
fi

# shellcheck source=lib/hook-input.sh
# Pure bash dirname: external `dirname` is missing when PATH is empty (the
# missing-jq fail-open probe), and a source failure under set -e would silence
# the gate. BASH_SOURCE is absolute when the harness invokes the script by path.
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
TOOL_NAME=$(agentkit_tool_name)

# Only trigger on Edit or Write tools (incl. Grok search_replace / write)
if ! agentkit_is_file_write_tool "$TOOL_NAME"; then
  exit 0
fi

# Extract the file path from tool input
FILE_PATH=$(agentkit_file_path)
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
  echo "⚠ dprint not found — skipping format" >&2
  exit 0
fi

# Find the nearest dprint.json by walking up from the file's directory
find_config() {
  local dir="$1"
  while [[ "$dir" != "/" && "$dir" != "$HOME" ]]; do
    [[ -f "$dir/dprint.json" ]] && echo "$dir/dprint.json" && return
    dir=$(dirname "$dir")
  done
}

CONFIG_FLAG=()
LOCAL_CONFIG=$(find_config "$(dirname "$FILE_PATH")")
if [[ -n "$LOCAL_CONFIG" ]]; then
  CONFIG_FLAG=(--config "$LOCAL_CONFIG")
elif [[ -n "${DPRINT_DEFAULT_CONFIG:-}" && -f "$DPRINT_DEFAULT_CONFIG" ]]; then
  CONFIG_FLAG=(--config "$DPRINT_DEFAULT_CONFIG")
else
  echo "⚠ no dprint.json found — set DPRINT_DEFAULT_CONFIG for a global fallback" >&2
  exit 0
fi

# Per-invocation temp file: a fixed /tmp path races concurrent sessions and is
# a symlink target.
ERR_LOG=$(mktemp "${TMPDIR:-/tmp}/dprint-err.XXXXXX")
trap 'rm -f "$ERR_LOG"' EXIT

if ! "$DPRINT" fmt "${CONFIG_FLAG[@]}" "$FILE_PATH" 2>"$ERR_LOG"; then
  err=$(cat "$ERR_LOG")
  echo "⚠ dprint fmt failed for $FILE_PATH: $err" >&2
  # ALLOWLIST, not a denylist. Only a failure dprint attributes to THIS file is
  # something the model can act on; everything else — an unresolvable plugin, a
  # scoped `includes` that excludes this extension, no network — is
  # infrastructure, and blocking on it turns every edit into an error nobody
  # can fix. Denylisting was tried and was unsound: dprint echoes the path into
  # the message, so a pattern like *config* silently swallowed real errors in
  # any file under a config/ directory.
  case "$err" in
    *"Error formatting $FILE_PATH"*) exit 2 ;;
  esac
  exit 0
fi

exit 0
