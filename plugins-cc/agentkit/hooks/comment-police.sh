#!/usr/bin/env bash
# comment-police.sh — Claude Code PostToolUse hook (matcher: Edit|Write)
# Claude-side counterpart of plugins/comment-police.ts; both read the
# `comment-police:` section of the agentkit config, so the keys must match.
#
# Checks ADDED lines only — a file's pre-existing comments are not the business
# of whoever touched one line of it.
set -euo pipefail

AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"

MAX_BLOCK_LINES=6
MAX_COMMENT_RATIO_PCT=30
EXCLUDE_PATTERNS=()

# Forge references rot: a comment lives as long as the repo, but issues and
# merge requests live in the forge, so a clone or a migration leaves the pointer
# dangling exactly when someone needs the reasoning.
FORGE_PATTERNS=(
  '[#!][0-9]{1,6}([^0-9a-zA-Z_]|$)'
  '(issue|ticket|PR|MR|merge request|pull request)[[:space:]]*[#!]?[0-9]+'
  '(gitlab|github)\.com/[^[:space:]]*/(issues|merge_requests|pull)/'
  '(commit|sha)[[:space:]]+[0-9a-f]{7,40}'
  '[Pp]lan-?[[:space:]]?[0-9]+'
  'as part of (this|the) (PR|MR|fix)'
  'see (issue|ticket|PR|MR)'
)

load_config() {
  [[ -f "$AGENTKIT_CONFIG" ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      max-block-lines) MAX_BLOCK_LINES="$value" ;;
      max-comment-ratio) MAX_COMMENT_RATIO_PCT=$(awk -v r="$value" 'BEGIN{printf "%d", r*100}') ;;
      exclude-pattern) EXCLUDE_PATTERNS+=("$value") ;;
    esac
  done < <(awk '
    /^[^[:space:]#]/ { in_section = ($0 ~ /^comment-police:/); in_excludes = 0; next }
    in_section {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (in_excludes) {
        if (line ~ /^-[[:space:]]*.+$/) { v = line; sub(/^-[[:space:]]*/, "", v); print "exclude-pattern=" v; next }
        in_excludes = 0
      }
      if (line ~ /^exclude-patterns:[[:space:]]*$/) { in_excludes = 1; next }
      if (line !~ /^(max-block-lines:[[:space:]]*[0-9]+|max-comment-ratio:[[:space:]]*[0-9.]+)([[:space:]]*#.*)?$/) next
      k = line; sub(/:.*/, "", k)
      sub(/^[^:]*:[[:space:]]*/, "", line); sub(/[[:space:]#].*$/, "", line)
      print k "=" line
    }
  ' "$AGENTKIT_CONFIG")
}
load_config

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
case "$(echo "$INPUT" | jq -r '.tool_name // empty')" in
  Edit|Write|edit|write) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')
[[ -z "$FILE_PATH" ]] && exit 0

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.py|*.rb|*.go|*.rs|*.java|*.kt|*.cs|*.cpp|*.c|*.h|*.hpp|*.swift|*.scala|*.vue|*.svelte|*.sh|*.bash) ;;
  *) exit 0 ;;
esac
case "$FILE_PATH" in
  *.lock|*.min.*|*.generated.*|*.snap|*.d.ts) exit 0 ;;
esac
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
  [[ "$FILE_PATH" == *"$pattern"* ]] && exit 0
done

ADDED=$(echo "$INPUT" | jq -r '.tool_input.new_string // .tool_input.content // empty')
[[ -z "$ADDED" ]] && exit 0

VIOLATIONS=()

is_comment_line() {
  [[ "$1" =~ ^[[:space:]]*(//|#|--|/\*|\*[^/]) ]] || [[ "$1" =~ ^[[:space:]]*\*$ ]]
}

check_blocks_and_ratio() {
  local run=0 worst=0 first="" comments=0 total=0
  while IFS= read -r line; do
    [[ -z "${line//[[:space:]]/}" ]] && continue
    total=$(( total + 1 ))
    if is_comment_line "$line"; then
      comments=$(( comments + 1 ))
      (( run == 0 )) && first="$(echo "$line" | sed 's/^[[:space:]]*//' | cut -c1-60)"
      run=$(( run + 1 ))
      (( run > worst )) && worst=$run
    else
      run=0
    fi
  done <<< "$ADDED"

  if (( worst > MAX_BLOCK_LINES )); then
    VIOLATIONS+=("COMMENT BLOCK TOO LONG: ${worst} consecutive comment lines (limit: ${MAX_BLOCK_LINES}), starting \"${first}...\". A comment earns its place by explaining non-obvious WHY. Restating what the code does, narrating history, or enumerating cases the code already enumerates is not that.")
  fi

  if (( total >= 10 )); then
    local pct=$(( comments * 100 / total ))
    if (( pct > MAX_COMMENT_RATIO_PCT )); then
      VIOLATIONS+=("TOO MANY COMMENTS: ${pct}% of the added lines are comments (limit: ${MAX_COMMENT_RATIO_PCT}%). If you are explaining the code, fix the code instead — rename, extract a helper, restructure.")
    fi
  fi
}

check_forbidden() {
  local hits="" pat
  while IFS= read -r line; do
    is_comment_line "$line" || continue
    for pat in "${FORGE_PATTERNS[@]}"; do
      if [[ "$line" =~ $pat ]]; then
        hits+="    ${line#"${line%%[![:space:]]*}"}"$'\n'
        break
      fi
    done
  done <<< "$ADDED"
  [[ -z "$hits" ]] && return 0
  VIOLATIONS+=("FORGE REFERENCE IN A COMMENT:
${hits}  Issues, merge requests and commit shas live in the forge, not the repo — a clone or a forge migration leaves the pointer dangling and the reasoning unreachable. State the reason in the comment itself; put traceability in the commit message; record durable decisions in an in-repo design doc.")
}

check_blocks_and_ratio
check_forbidden

if (( ${#VIOLATIONS[@]} > 0 )); then
  {
    echo ""
    echo "COMMENT DISCIPLINE VIOLATION (comment-police)"
    echo "=================================================="
    for i in "${!VIOLATIONS[@]}"; do
      echo "$(( i + 1 )). ${VIOLATIONS[$i]}"
      echo ""
    done
    echo "REQUIRED ACTIONS:"
    echo "- Default to no comment; add one only for non-obvious WHY."
    echo "- Keep blocks to ${MAX_BLOCK_LINES} lines or fewer."
    echo "- No issue/MR/PR numbers, commit shas, plan numbers, or forge URLs in source."
    echo "- Traceability goes in the commit message; durable decisions in an in-repo doc."
    echo ""
    echo "Fix these before proceeding."
  } >&2
fi

exit 0
