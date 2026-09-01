#!/usr/bin/env bash
# prose-police.sh — Claude Code PostToolUse hook (matcher: Edit|Write)
# Flags AI writing tells in ADDED prose only — a document's pre-existing slop
# is not the business of whoever touched one paragraph of it. Pattern content
# adapted from blader/humanizer and conorbronsdon/avoid-ai-writing (both MIT;
# see NOTICE).
set -euo pipefail

if [[ -n "${AGENTKIT_SKIP_HOOKS:-}" ]]; then
  _skip=",$(printf '%s' "$AGENTKIT_SKIP_HOOKS" | tr -d '[:space:]'),"
  case "$_skip" in
    *",prose-police,"*|*",all,"*) exit 0 ;;
  esac
fi

AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"

ENABLED=1
MAX_EMDASH_PER_100_WORDS=3
MIN_WORDS_FOR_DENSITY=150
MIN_DASHES_FOR_DENSITY=4
EXCLUDE_PATTERNS=()

load_config() {
  [[ -f "$AGENTKIT_CONFIG" ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      enabled) case "$value" in false|0|no) ENABLED=0 ;; esac ;;
      max-em-dash-per-100-words) MAX_EMDASH_PER_100_WORDS="$value" ;;
      exclude-pattern) EXCLUDE_PATTERNS+=("$value") ;;
    esac
  done < <(awk '
    /^[^[:space:]#]/ { in_section = ($0 ~ /^prose-police:/); in_excludes = 0; next }
    in_section {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (in_excludes) {
        if (line ~ /^-[[:space:]]*.+$/) { v = line; sub(/^-[[:space:]]*/, "", v); print "exclude-pattern=" v; next }
        in_excludes = 0
      }
      if (line ~ /^exclude-patterns:[[:space:]]*$/) { in_excludes = 1; next }
      if (line !~ /^(enabled:[[:space:]]*[a-z01]+|max-em-dash-per-100-words:[[:space:]]*[0-9]+)([[:space:]]*#.*)?$/) next
      k = line; sub(/:.*/, "", k)
      sub(/^[^:]*:[[:space:]]*/, "", line); sub(/[[:space:]#].*$/, "", line)
      print k "=" line
    }
  ' "$AGENTKIT_CONFIG")
}
load_config
(( ENABLED )) || exit 0

command -v jq >/dev/null 2>&1 || exit 0

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
if ! agentkit_is_file_write_tool; then
  exit 0
fi

FILE_PATH=$(agentkit_file_path)
[[ -z "$FILE_PATH" ]] && exit 0

case "$FILE_PATH" in
  *.md|*.mdx|*.markdown|*.txt) ;;
  *) exit 0 ;;
esac

# Self-exemption: the rule, skill, and config that TEACH these patterns must
# quote them, and a changelog quotes history it cannot rewrite.
case "$FILE_PATH" in
  *CHANGELOG*|*LICENSE*|*NOTICE*|*node_modules/*|*/.omc/*) exit 0 ;;
  *writing-discipline*|*prose-police*|*humanize*|*anti-glaze*) exit 0 ;;
esac
for pattern in "${EXCLUDE_PATTERNS[@]+"${EXCLUDE_PATTERNS[@]}"}"; do
  [[ "$FILE_PATH" == *"$pattern"* ]] && exit 0
done

repo_dir="${FILE_PATH%/*}"
if repo_flag=$(git -C "$repo_dir" config --get agentkit.prosepolice.enabled 2>/dev/null); then
  case "$repo_flag" in false|0|no) exit 0 ;; esac
fi

ADDED=$(agentkit_edit_text)
[[ -z "$ADDED" ]] && exit 0

# Fenced code and inline code spans are not prose; a snippet may legitimately
# name anything.
# shellcheck disable=SC2016 # sed pattern strips literal backtick code spans.
PROSE=$(printf '%s\n' "$ADDED" | awk '
  /^[[:space:]]*(```|~~~)/ { in_fence = !in_fence; next }
  !in_fence
' | sed 's/`[^`]*`//g')
[[ -z "${PROSE//[[:space:]]/}" ]] && exit 0

SLOP_PATTERNS=(
  '\bdelv(e|es|ed|ing)\b'
  '\btapestry\b'
  '\bplethora\b'
  '\bmyriad of\b'
  '\btreasure trove\b'
  '\bsynerg(y|ies|istic|ize)'
  '\bparadigm shift\b'
  '\bgame.?chang(er|ing)\b'
  '\bcutting.?edge\b'
  '\bgroundbreaking\b'
  '\brevolutioniz(e|es|ed|ing)\b'
  '\bholistic(ally)?\b'
  '\bembark(s|ed|ing)? on\b'
  '\belevate your\b'
  '\bunlock (the )?(full |true )?potential\b'
  '\bharness (the )?power\b'
  '\bnavigat(e|ing) the complexit'
  '\bdouble.?edged sword\b'
  '\bleverag(es|ed|ing)\b'
  '\b(to|we|you|they) leverage\b'
  '\ba testament to\b'
  '\bstands? as a testament\b'
  '\bplays? a (vital|crucial|pivotal|critical) role\b'
  '\bunderscores? the importance\b'
  '\b(ever.)?evolving landscape\b'
  '\bpivotal moment\b'
  "\\bin today'?s (fast.paced|competitive|digital|ever.changing|rapidly.evolving|modern)\\b"
  '\bin the (world|realm|landscape) of\b'
  '\bat the end of the day\b'
  "\\bit'?s (worth|important) (noting|to note|mentioning|to mention)\\b"
  '\bneedless to say\b'
  '\bgreat question\b'
  "\\byou'?re absolutely right\\b"
  '\bi hope this helps\b'
  "\\blet'?s dive in(to)?\\b"
  '\bdive deeper? into\b'
  '\bwithout further ado\b'
  "\\b(isn'?t|aren'?t|wasn'?t|weren'?t|(is|are|was|were|it'?s|they'?re) not) (just|only|merely|simply)\\b[^.!?]{1,80}\\bbut( also)?\\b"
  "it'?s not [^.!?]{1,60}[,;—-] *it'?s"
)

VIOLATIONS=()

check_slop_phrases() {
  local hits="" pat line phrase
  for pat in "${SLOP_PATTERNS[@]+"${SLOP_PATTERNS[@]}"}"; do
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      phrase=$(printf '%s' "$line" | grep -Eio -- "$pat" | head -1) || true
      hits+="    \"${phrase}\" in: $(printf '%s' "$line" | cut -c1-100)"$'\n'
    done < <(printf '%s\n' "$PROSE" | grep -Ei -- "$pat" | head -2)
  done
  [[ -z "$hits" ]] && return 0
  hits=$(printf '%s' "$hits" | awk '!seen[$0]++' | head -12)
  VIOLATIONS+=("AI-TELL PHRASING in the added prose:
${hits}
  These constructions (delve/tapestry vocabulary, significance inflation, negative parallelism, chatbot filler) read as generated text. Say the specific thing plainly instead.")
}

check_emdash_density() {
  local words dashes
  words=$(printf '%s' "$PROSE" | wc -w | tr -d '[:space:]')
  (( words >= MIN_WORDS_FOR_DENSITY )) || return 0
  # grep exits 1 on zero matches, and pipefail would turn that into a silent
  # mid-script death that swallows every finding already collected.
  dashes=$(printf '%s' "$PROSE" | grep -o '—' | wc -l | tr -d '[:space:]') || dashes=0
  (( dashes >= MIN_DASHES_FOR_DENSITY )) || return 0
  (( dashes * 100 > MAX_EMDASH_PER_100_WORDS * words )) || return 0
  VIOLATIONS+=("EM-DASH PILE-UP: ${dashes} em dashes in ${words} added words (limit: ${MAX_EMDASH_PER_100_WORDS} per 100). Vary the joinery — most of these want a period, a comma, or a plain sentence.")
}

check_slop_phrases
check_emdash_density

if (( ${#VIOLATIONS[@]} > 0 )); then
  {
    echo ""
    echo "PROSE DISCIPLINE VIOLATION (prose-police)"
    echo "=================================================="
    for i in "${!VIOLATIONS[@]}"; do
      echo "$(( i + 1 )). ${VIOLATIONS[$i]}"
      echo ""
    done
    echo "REQUIRED ACTIONS:"
    echo "- Rewrite the flagged lines in plain, specific language (the humanize skill does this wholesale)."
    echo "- State facts directly; cut inflation, hedging, and formula."
    echo "- Off switches: AGENTKIT_SKIP_HOOKS=prose-police (session); git config agentkit.prosepolice.enabled false (repo); or in agentkit config.yaml (global), an 'enabled: false' line nested under a 'prose-police:' section."
    echo ""
    echo "Fix these before proceeding."
  } >&2
  # Exit 2 is what delivers this. Claude Code discards a PostToolUse
  # hook's stderr at exit 0, so the check ran and nobody heard it.
  exit 2
fi

exit 0
