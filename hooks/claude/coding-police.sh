#!/usr/bin/env bash
# coding-police.sh — Claude Code PostToolUse hook (matcher: Edit|Write)
# Enforces: DRY code, modular files (<1000 lines), short functions, single responsibility
# Equivalent to: plugins/coding-police.ts (OpenCode)
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────
AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"

MAX_FILE_LINES=1000
MAX_FUNCTION_LINES=100
MIN_DUPLICATE_LINES=6
MAX_EXPORTS_PER_FILE=15

load_config() {
  [[ -f "$AGENTKIT_CONFIG" ]] || return 0
  local section
  section=$(sed -n '/^coding-police:/,/^[^ ]/p' "$AGENTKIT_CONFIG" | head -n -1)
  [[ -z "$section" ]] && return 0

  local val
  val=$(echo "$section" | grep -oP 'max-file-lines:\s*\K\d+' || true)
  [[ -n "$val" ]] && MAX_FILE_LINES="$val"

  val=$(echo "$section" | grep -oP 'max-function-lines:\s*\K\d+' || true)
  [[ -n "$val" ]] && MAX_FUNCTION_LINES="$val"

  val=$(echo "$section" | grep -oP 'min-duplicate-lines:\s*\K\d+' || true)
  [[ -n "$val" ]] && MIN_DUPLICATE_LINES="$val"

  val=$(echo "$section" | grep -oP 'max-exports-per-file:\s*\K\d+' || true)
  [[ -n "$val" ]] && MAX_EXPORTS_PER_FILE="$val"
}
load_config

# ── Input parsing ───────────────────────────────────────────────────────────
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

# Only check code files
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.py|*.rb|*.go|*.rs|*.java|*.kt|*.cs|*.cpp|*.c|*.h|*.hpp|*.swift|*.scala|*.vue|*.svelte) ;;
  *) exit 0 ;;
esac

# Skip generated/lock files
case "$FILE_PATH" in
  *.lock|*.min.*|*.generated.*|*.snap|*.d.ts|package-lock.json|yarn.lock|pnpm-lock.yaml)
    exit 0 ;;
esac

[[ -f "$FILE_PATH" ]] || exit 0

VIOLATIONS=()

# ── Check 1: File length ───────────────────────────────────────────────────
check_file_length() {
  local line_count
  line_count=$(wc -l < "$FILE_PATH")
  if (( line_count > MAX_FILE_LINES )); then
    local excess=$(( line_count - MAX_FILE_LINES ))
    VIOLATIONS+=("FILE TOO LONG: ${line_count} lines (limit: ${MAX_FILE_LINES}, over by ${excess}). Split this file into smaller modules grouped by functionality. Identify logical boundaries (types, helpers, handlers, constants) and extract them.")
  fi
}

# ── Check 2: Function lengths ──────────────────────────────────────────────
check_function_lengths() {
  # Use awk to find function definitions and track brace depth
  local long_funcs
  long_funcs=$(awk -v max="$MAX_FUNCTION_LINES" '
    # Match function starts for TS/JS/Go/Rust/Java/C
    /^[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+[a-zA-Z_]/ ||
    /^[[:space:]]*(export[[:space:]]+)?(const|let|var)[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*=[[:space:]]*(async[[:space:]]*)?\(/ ||
    /^[[:space:]]*(pub[[:space:]]+)?(async[[:space:]]+)?fn[[:space:]]+[a-zA-Z_]/ ||
    /^[[:space:]]*func[[:space:]]+(\([^)]*\)[[:space:]]+)?[a-zA-Z_]/ {
      if (in_func && depth == 0) {
        len = NR - func_start
        if (len > max) {
          printf "LONG FUNCTION: `%s` is %d lines (limit: %d, starts at line %d). Break it into smaller helper functions.\n", func_name, len, max, func_start
        }
      }
      # Extract function name
      name = $0
      gsub(/^[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?(pub[[:space:]]+)?/, "", name)
      gsub(/^(function|fn|func|const|let|var)[[:space:]]+/, "", name)
      gsub(/(\([^)]*\)[[:space:]]+)?/, "", name)  # Go receiver
      gsub(/[[:space:]]*[=({:.].*/, "", name)
      func_name = name
      func_start = NR
      depth = 0
      in_func = 1
    }

    # Also match Python def
    /^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+[a-zA-Z_]/ {
      if (in_func && depth == 0 && NR > func_start) {
        len = NR - func_start
        if (len > max) {
          printf "LONG FUNCTION: `%s` is %d lines (limit: %d, starts at line %d). Break it into smaller helper functions.\n", func_name, len, max, func_start
        }
      }
      name = $0
      gsub(/^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+/, "", name)
      gsub(/[[:space:]]*\(.*/, "", name)
      func_name = name
      func_start = NR
      depth = 0
      in_func = 1
    }

    in_func {
      n = split($0, chars, "")
      for (i = 1; i <= n; i++) {
        if (chars[i] == "{") depth++
        if (chars[i] == "}") depth--
      }
      if (depth <= 0 && NR > func_start && index($0, "}") > 0) {
        len = NR - func_start + 1
        if (len > max) {
          printf "LONG FUNCTION: `%s` is %d lines (limit: %d, starts at line %d). Break it into smaller helper functions.\n", func_name, len, max, func_start
        }
        in_func = 0
      }
    }

    END {
      if (in_func && depth == 0) {
        len = NR - func_start
        if (len > max) {
          printf "LONG FUNCTION: `%s` is %d lines (limit: %d, starts at line %d). Break it into smaller helper functions.\n", func_name, len, max, func_start
        }
      }
    }
  ' "$FILE_PATH" 2>/dev/null || true)

  while IFS= read -r line; do
    if [[ -n "$line" ]]; then VIOLATIONS+=("$line"); fi
  done <<< "$long_funcs"
}

# ── Check 3: Duplicate code blocks ─────────────────────────────────────────
check_duplicate_blocks() {
  # Normalise: strip comments, blank lines, imports, then find repeated blocks
  local dupes
  dupes=$(awk -v min="$MIN_DUPLICATE_LINES" '
    BEGIN { idx = 0 }
    {
      line = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)

      # Skip blank, comments, imports, single-char structural lines
      if (line == "") next
      if (line ~ /^\/\//) next
      if (line ~ /^#/) next
      if (line ~ /^\*/) next
      if (line ~ /^\/\*/) next
      if (line ~ /^\*\//) next
      if (line ~ /^(import|from|require|use |using )/) next
      if (line ~ /^[{}()\[\];,]$/) next

      idx++
      norm[idx] = line
      orig[idx] = NR
    }
    END {
      for (i = 1; i <= idx - min + 1; i++) {
        block = ""
        for (k = 0; k < min; k++) {
          block = block norm[i + k] "\n"
        }

        if (block in seen) {
          first = seen[block]
          key = first ":" orig[i]
          if (!(key in reported)) {
            reported[key] = 1
            printf "DUPLICATE CODE: %d+ line block duplicated at lines %d and %d. Extract into a shared function to keep code DRY.\n", min, first, orig[i]
          }
        } else {
          seen[block] = orig[i]
        }
      }
    }
  ' "$FILE_PATH" 2>/dev/null || true)

  while IFS= read -r line; do
    if [[ -n "$line" ]]; then VIOLATIONS+=("$line"); fi
  done <<< "$dupes"
}

# ── Check 4: Export count (TS/JS only) ──────────────────────────────────────
check_export_count() {
  case "$FILE_PATH" in
    *.ts|*.tsx|*.js|*.jsx) ;;
    *) return 0 ;;
  esac

  local count
  count=$(grep -cE '^\s*export\s+(default\s+)?(function|class|const|let|var|type|interface|enum|async)' "$FILE_PATH" 2>/dev/null || true)
  count=${count:-0}
  if (( count > MAX_EXPORTS_PER_FILE )); then
    VIOLATIONS+=("TOO MANY EXPORTS: ${count} exports in this file (limit: ${MAX_EXPORTS_PER_FILE}). This suggests the file has multiple responsibilities. Group related exports into separate modules (e.g., types.ts, helpers.ts, constants.ts).")
  fi
}

# ── Run all checks ──────────────────────────────────────────────────────────
check_file_length
check_function_lengths
check_duplicate_blocks
check_export_count

# ── Output violations ──────────────────────────────────────────────────────
if (( ${#VIOLATIONS[@]} > 0 )); then
  {
    echo ""
    echo "CODING STANDARDS VIOLATION (coding-police)"
    echo "=================================================="
    for i in "${!VIOLATIONS[@]}"; do
      echo "$(( i + 1 )). ${VIOLATIONS[$i]}"
      echo ""
    done
    echo "REQUIRED ACTIONS:"
    echo "- Keep code DRY: extract duplicated logic into shared functions."
    echo "- Keep files modular: split files exceeding ${MAX_FILE_LINES} lines by functionality."
    echo "- Keep functions focused: break functions over ${MAX_FUNCTION_LINES} lines into composable helpers."
    echo "- Apply Single Responsibility: each file should have one clear purpose."
    echo ""
    echo "Fix these violations before proceeding."
  } >&2
fi

exit 0
