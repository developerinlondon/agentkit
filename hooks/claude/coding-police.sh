#!/usr/bin/env bash
# coding-police.sh — Claude Code PostToolUse hook (matcher: Edit|Write)
# Enforces: DRY code, modular files (<1000 lines), short functions, single responsibility
# Equivalent to: plugins/coding-police.ts (OpenCode)
set -euo pipefail

# Kill switch, matching the AGENTKIT_* convention used by the PreToolUse
# police. Comma-separated hook names; a blocking hook with no way off is a
# hook that eventually gets deleted instead of configured.
# Trimmed, so "a, b" behaves like "a,b" — version-police already trims, and two
# readings of one env var is a silent disagreement.
if [[ -n "${AGENTKIT_SKIP_HOOKS:-}" ]]; then
  _skip=",$(printf '%s' "$AGENTKIT_SKIP_HOOKS" | tr -d '[:space:]'),"
  case "$_skip" in
    *",coding-police,"*|*",all,"*) exit 0 ;;
  esac
fi

# ── Configuration ───────────────────────────────────────────────────────────
AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"

MAX_FILE_LINES=1000
MAX_FUNCTION_LINES=100
MIN_DUPLICATE_LINES=6
MAX_EXPORTS_PER_FILE=15
MAX_DIR_FILES=15
EXCLUDE_PATTERNS=()

load_config() {
  [[ -f "$AGENTKIT_CONFIG" ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      max-file-lines) MAX_FILE_LINES="$value" ;;
      max-function-lines) MAX_FUNCTION_LINES="$value" ;;
      min-duplicate-lines) MIN_DUPLICATE_LINES="$value" ;;
      max-exports-per-file) MAX_EXPORTS_PER_FILE="$value" ;;
      max-dir-files) MAX_DIR_FILES="$value" ;;
      exclude-pattern) EXCLUDE_PATTERNS+=("$value") ;;
    esac
  done < <(awk '
    /^[^[:space:]#]/ {
      in_section = ($0 ~ /^coding-police:/)
      in_excludes = 0
      next
    }
    in_section {
      line = $0
      sub(/^[[:space:]]+/, "", line)

      if (in_excludes) {
        if (line ~ /^-[[:space:]]*.+$/) {
          value = line
          sub(/^-[[:space:]]*/, "", value)
          print "exclude-pattern=" value
          next
        }
        in_excludes = 0
      }

      if (line ~ /^exclude-patterns:[[:space:]]*$/) {
        in_excludes = 1
        next
      }

      if (line !~ /^(max-file-lines|max-function-lines|min-duplicate-lines|max-exports-per-file|max-dir-files):[[:space:]]*[0-9]+([[:space:]]*#.*)?$/) next
      key = line
      sub(/:.*/, "", key)
      sub(/^[^:]*:[[:space:]]*/, "", line)
      sub(/[[:space:]#].*$/, "", line)
      print key "=" line
    }
  ' "$AGENTKIT_CONFIG")
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

IS_CODE_FILE=false
SHOULD_CHECK_PATHS=false

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.py|*.rb|*.go|*.rs|*.java|*.kt|*.cs|*.cpp|*.c|*.h|*.hpp|*.swift|*.scala|*.vue|*.svelte)
    IS_CODE_FILE=true
    SHOULD_CHECK_PATHS=true
    ;;
  *.yml|*.yaml|*.toml|*.json|*.jsonc|*.ini|*.env|*.service|*.conf|*.cfg)
    SHOULD_CHECK_PATHS=true
    ;;
  *) exit 0 ;;
esac

# Skip generated/lock files
case "$FILE_PATH" in
  *.lock|*.min.*|*.generated.*|*.snap|*.d.ts|package-lock.json|yarn.lock|pnpm-lock.yaml)
    exit 0 ;;
esac

# Skip paths matching an exclude-patterns entry (e.g. homogeneous routes/migrations dirs)
for pattern in "${EXCLUDE_PATTERNS[@]+"${EXCLUDE_PATTERNS[@]}"}"; do
  [[ "$FILE_PATH" == *"$pattern"* ]] && exit 0
done

[[ -f "$FILE_PATH" ]] || exit 0

VIOLATIONS=()

# ── Check 0: Cross-repo sibling relative paths ─────────────────────────────
check_cross_repo_relative_paths() {
  [[ "$SHOULD_CHECK_PATHS" == true ]] || return 0

  local matches
  matches=$(grep -nE '\{\{[[:space:]]*(inventory_dir|playbook_dir|role_path|ansible_parent_role_paths\[[^]]+\])[[:space:]]*\}\}[[:space:]]*/(\.\./){2,}|(^|["'"'"'=[:space:]])(\.\./){2,}(core|eda|fullcircle|dashboard|gitops|infra|ansible-roles)(/|["'"'"'[:space:]]|$)' "$FILE_PATH" 2>/dev/null || true)

  while IFS= read -r line; do
    if [[ -n "$line" ]]; then
      VIOLATIONS+=("CROSS-REPO RELATIVE PATH: ${line}. Do not depend on checkout layout across repos; use a published artifact, a vendored/submodule path inside this repo, or runtime configuration.")
    fi
  done <<< "$matches"
}

# ── Check 1: File length ───────────────────────────────────────────────────

# The committed version of FILE_PATH, or empty when it is new / not in git.
# Whole-file checks measure state the current edit may not have caused; a file
# that was already too long would otherwise block EVERY later edit to it,
# unfixably, and Claude Code has no PostToolUse loop guard to stop that.
baseline_of() {
  local top rel
  top=$(git -C "$(dirname "$FILE_PATH")" rev-parse --show-toplevel 2>/dev/null) || return 0
  rel=${FILE_PATH#"$top"/}
  git -C "$top" show "HEAD:$rel" 2>/dev/null || true
}


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
  count=$(grep -cE '^[[:space:]]*export[[:space:]]+(default[[:space:]]+)?(function|class|const|let|var|type|interface|enum|async)' "$FILE_PATH" 2>/dev/null || true)
  count=${count:-0}
  if (( count > MAX_EXPORTS_PER_FILE )); then
    VIOLATIONS+=("TOO MANY EXPORTS: ${count} exports in this file (limit: ${MAX_EXPORTS_PER_FILE}). This suggests the file has multiple responsibilities. Group related exports into separate modules (e.g., types.ts, helpers.ts, constants.ts).")
  fi
}

# ── Check 6: Monolith directory (Write only — Edit cannot create new files) ─
check_monolith_directory() {
  case "$TOOL_NAME" in
    Write|write) ;;
    *) return 0 ;;
  esac
  (( MAX_DIR_FILES > 0 )) || return 0

  local dir base git_err git_status=0
  dir=$(dirname -- "$FILE_PATH")
  base=$(basename -- "$FILE_PATH")

  # A file is "new" when git has never tracked it. Any failure (no repo,
  # git missing) fails open so the check never blocks when it can't tell.
  git_err=$(git -C "$dir" ls-files --error-unmatch -- "$base" 2>&1) || git_status=$?
  (( git_status == 0 )) && return 0
  [[ "$git_err" == *"not a git repository"* ]] && return 0

  local count=0 entry excluded pattern
  for entry in "$dir"/*; do
    [[ -f "$entry" ]] || continue
    [[ "$entry" == "$FILE_PATH" ]] && continue
    case "$entry" in
      *.ts|*.tsx|*.js|*.jsx|*.py|*.rb|*.go|*.rs|*.java|*.kt|*.cs|*.cpp|*.c|*.h|*.hpp|*.swift|*.scala|*.vue|*.svelte) ;;
      *) continue ;;
    esac
    case "$entry" in
      *.lock|*.min.*|*.generated.*|*.snap|*.d.ts|package-lock.json|yarn.lock|pnpm-lock.yaml) continue ;;
    esac

    excluded=false
    for pattern in "${EXCLUDE_PATTERNS[@]+"${EXCLUDE_PATTERNS[@]}"}"; do
      [[ "$entry" == *"$pattern"* ]] && { excluded=true; break; }
    done
    [[ "$excluded" == true ]] && continue

    count=$(( count + 1 ))
  done

  if (( count >= MAX_DIR_FILES )); then
    VIOLATIONS+=("MONOLITH DIRECTORY: ${dir} already has ${count} source files (cap: ${MAX_DIR_FILES}). Group files into domain subfolders instead of adding more flat files here.")
  fi
}

# ── Run all checks ──────────────────────────────────────────────────────────
check_cross_repo_relative_paths

if [[ "$IS_CODE_FILE" != true ]]; then
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
      echo "- Remove cross-repo sibling relative paths from durable config."
      echo "- Use published artifacts, vendored/submodule paths inside the same repo, or runtime configuration."
      echo ""
      echo "Fix these violations before proceeding."
    } >&2
    exit 2
  fi
  exit 0
fi

# Whole-file checks measure state this edit may not have caused. Run them once
# against the committed baseline and once against the working file, then report
# only what is NEW — otherwise a legacy file with a long function or a
# duplicated block nags after every unrelated edit, forever, and there is no
# PostToolUse loop guard to stop it.
#
# Compared as a MULTISET of violations with every number blanked. Numbers are
# line offsets and sizes that shift when unrelated lines move, so matching on
# them reported untouched legacy code and hid genuinely new violations. Blanking
# them compares the SHAPE and the identifier; counting occurrences means a
# second duplicate block, or a second over-long function, still surfaces.
# Blank the numeric FIELDS for the shape, and carry the severity separately.
# Keeping sizes in the shape made the compare symmetric: a metric that moved in
# either direction stopped matching, so DELETING 100 lines from an over-limit
# file reported it as new — punishing the model for the cleanup the rule asks
# for. The shape answers "same violation?"; the metric answers "worse?".
#
# Field by field, never a blanket s/[0-9]+/#/g: that also rewrote the backticked
# identifier, so `handleV1Request` and `handleV2Request` collapsed into ONE
# shape and the worse-slot pass below handed a real regression the other
# function's slot — reporting nothing at all. Silence is the fail-open
# direction. Directory paths and quoted source lines have the same hazard.
violation_shape() {
  printf '%s' "$1" | sed -E '
    s/^(FILE TOO LONG: )[0-9]+/\1#/
    s/^(DUPLICATE CODE: )[0-9]+/\1#/
    s/^(TOO MANY EXPORTS: )[0-9]+/\1#/
    s/( is )[0-9]+( lines)/\1#\2/
    s/(limit: )[0-9]+/\1#/
    s/(cap: )[0-9]+/\1#/
    s/(over by )[0-9]+/\1#/
    s/(already has )[0-9]+/\1#/
    s/(at lines? )[0-9]+/\1#/g
    s/( and )[0-9]+/\1#/g
  '
}

# The severity number, chosen per message TYPE. Never "the largest number in
# the line" — that picked up `starts at line 201` and inverted the comparison
# on any file long enough for a line number to exceed a length.
violation_metric() {
  local m
  case "$1" in
    "FILE TOO LONG: "*) m=$(printf '%s' "$1" | sed -E 's/^FILE TOO LONG: ([0-9]+) lines.*/\1/') ;;
    "LONG FUNCTION: "*) m=$(printf '%s' "$1" | sed -E 's/^LONG FUNCTION: .* is ([0-9]+) lines.*/\1/') ;;
    "DUPLICATE CODE: "*) m=$(printf '%s' "$1" | sed -E 's/^DUPLICATE CODE: ([0-9]+)\+ line.*/\1/') ;;
    "TOO MANY EXPORTS: "*) m=$(printf '%s' "$1" | sed -E 's/^TOO MANY EXPORTS: ([0-9]+) exports.*/\1/') ;;
    *) m=0 ;;
  esac
  # A sed that did not match returns the whole line; that must not reach $(( )).
  [[ "$m" =~ ^[0-9]+$ ]] || m=0
  printf '%s' "$m"
}

# The cross-repo check already ran and its findings are NOT whole-file state —
# they must survive the baseline pass, which resets the array.
PRE_EXISTING=("${VIOLATIONS[@]+"${VIOLATIONS[@]}"}")

BASE_SHAPES=()
BASE_METRICS=()
BASELINE_FILE=""
baseline_content=$(baseline_of)
if [[ -n "$baseline_content" ]]; then
  # mktemp needs the X's LAST (BSD accepts no suffix), but the baseline file is
  # then measured as if it were the real one — and check_export_count gates on
  # the extension, so an extensionless temp file silently skipped that check and
  # left every over-cap file blocking its own edits forever. Rename it back.
  BASELINE_FILE=$(mktemp "${TMPDIR:-/tmp}/coding-police-base-XXXXXX")
  # Under `set -e` a failure here would kill the hook between mktemp and rm:
  # it would leak the file and, worse, emit no decision at all — which the
  # harness reads as ALLOW. Degrade to "no baseline" instead of dying.
  trap 'rm -f "$BASELINE_FILE"' EXIT
  baseline_ext="${FILE_PATH##*.}"
  if [[ "$baseline_ext" != "$FILE_PATH" ]]; then
    if mv -f -- "$BASELINE_FILE" "$BASELINE_FILE.$baseline_ext"; then
      BASELINE_FILE="$BASELINE_FILE.$baseline_ext"
    else
      rm -f "$BASELINE_FILE"
      BASELINE_FILE=""
    fi
  fi
fi

# Empty when there is no committed baseline, or the rename failed and the
# baseline was abandoned. Both mean "measure nothing" — never "die".
if [[ -n "$BASELINE_FILE" ]]; then
  printf '%s\n' "$baseline_content" > "$BASELINE_FILE"
  REAL_FILE_PATH="$FILE_PATH"
  FILE_PATH="$BASELINE_FILE"
  VIOLATIONS=()
  check_file_length
  check_function_lengths
  check_duplicate_blocks
  check_export_count
  for v in "${VIOLATIONS[@]+"${VIOLATIONS[@]}"}"; do
    BASE_SHAPES+=("$(violation_shape "$v")")
    BASE_METRICS+=("$(violation_metric "$v")")
  done
  FILE_PATH="$REAL_FILE_PATH"
  rm -f "$BASELINE_FILE"
  trap - EXIT
fi

VIOLATIONS=()
check_file_length
check_function_lengths
check_duplicate_blocks
check_export_count
check_monolith_directory

if (( ${#BASE_SHAPES[@]} > 0 )); then
  KEPT=()
  for v in "${VIOLATIONS[@]+"${VIOLATIONS[@]}"}"; do
    shape=$(violation_shape "$v")
    metric=$(violation_metric "$v")
    matched=""
    # Same severity first, so an unchanged violation claims its own baseline
    # slot before a shrunken one consumes a bigger neighbour's and leaves the
    # neighbour looking new.
    for i in "${!BASE_SHAPES[@]}"; do
      if [[ "${BASE_SHAPES[$i]}" == "$shape" ]] && (( BASE_METRICS[i] == metric )); then
        matched=$i
        break
      fi
    done
    if [[ -z "$matched" ]]; then
      # Otherwise any baseline slot that was WORSE absorbs it — an improvement
      # is silent. A metric above every slot is a real regression and is kept.
      for i in "${!BASE_SHAPES[@]}"; do
        if [[ "${BASE_SHAPES[$i]}" == "$shape" ]] && (( BASE_METRICS[i] > metric )); then
          matched=$i
          break
        fi
      done
    fi
    if [[ -n "$matched" ]]; then
      # Consume it: a THIRD duplicate block when the baseline had two is new.
      unset 'BASE_SHAPES[matched]' 'BASE_METRICS[matched]'
    else
      KEPT+=("$v")
    fi
  done
  VIOLATIONS=("${KEPT[@]+"${KEPT[@]}"}")
fi

VIOLATIONS=("${PRE_EXISTING[@]+"${PRE_EXISTING[@]}"}" "${VIOLATIONS[@]+"${VIOLATIONS[@]}"}")

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
    echo "- Keep directories navigable: group files into domain subfolders instead of growing past ${MAX_DIR_FILES} flat files."
    echo "- Remove cross-repo sibling relative paths from durable config."
    echo ""
    echo "Fix these violations before proceeding."
  } >&2
  # Exit 2 is what delivers this. Claude Code discards a PostToolUse
  # hook's stderr at exit 0, so the check ran and nobody heard it.
  exit 2
fi

exit 0
