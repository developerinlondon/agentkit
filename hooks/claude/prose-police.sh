#!/usr/bin/env bash
# prose-police.sh — registered twice: PostToolUse (Edit|Write) for file prose,
# PreToolUse (Bash) for inline gh/glab --body/--title text. Flags AI writing
# tells in ADDED prose only — pre-existing slop is not this edit's business.
# Patterns adapted from blader/humanizer and avoid-ai-writing (MIT; NOTICE).
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

MODE=""
COMMAND=$(agentkit_command)
if [[ -n "$COMMAND" ]]; then
  MODE="bash"
elif agentkit_is_file_write_tool; then
  MODE="file"
else
  exit 0
fi

prosepolice_repo_off() {
  local flag
  if flag=$(git "$@" config --get agentkit.prosepolice.enabled 2>/dev/null); then
    case "$flag" in false|0|no) return 0 ;; esac
  fi
  return 1
}

# Fenced code and inline code spans are not prose; a snippet may legitimately
# name anything.
strip_code_spans() {
  # shellcheck disable=SC2016 # sed pattern strips literal backtick code spans.
  awk '
    /^[[:space:]]*(```|~~~)/ { in_fence = !in_fence; next }
    !in_fence
  ' | sed 's/`[^`]*`//g'
}

# Scanning is scoped to the simple command whose head is gh/glab — a commit
# message or curl payload sharing the line is not forge text. shlex, because a
# body is a quoted argument containing everything a regex would have to
# survive. Missing python3 fails open, matching issue-police.
extract_inline_forge_text() {
  # Cheap trigger only — segmentation below is what decides ownership, since a
  # quoted gh collapses into one token and can never be a segment head.
  printf '%s' "$COMMAND" | grep -qE '\b(gh|glab)([[:space:]]|$)' || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  COMMAND="$COMMAND" python3 -c '
import os, shlex, sys

flags = ("--body", "-b", "--description", "-d", "--title", "-t", "--notes",
         "--message", "-m", "--comment")
fields = ("body", "description", "title", "notes")
file_flags = ("--body-file", "--description-file", "-F")

def tokens(text):
    lex = shlex.shlex(text, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)

try:
    parts = tokens(os.environ["COMMAND"])
except ValueError:
    sys.exit(0)

segments, current = [], []
for part in parts:
    if part and all(c in ";|&(){}<>" for c in part):
        segments.append(current)
        current = []
    else:
        current.append(part)
segments.append(current)

out = []
for seg in segments:
    head = 0
    while head < len(seg) and "=" in seg[head] and not seg[head].startswith("-"):
        head += 1
    if head >= len(seg) or seg[head] not in ("gh", "glab"):
        continue
    for i, part in enumerate(seg):
        if part in flags and i + 1 < len(seg):
            out.append(seg[i + 1])
            continue
        if any(part.startswith(f + "=") for f in flags):
            out.append(part.split("=", 1)[1])
            continue
        pair = None
        if part in ("--field", "-f", "--raw-field", "-F") and i + 1 < len(seg):
            pair = seg[i + 1]
        elif part.startswith(("--field=", "--raw-field=")):
            pair = part.split("=", 1)[1]
        if pair and "=" in pair:
            key, value = pair.split("=", 1)
            if key in fields:
                out.append(value)
            continue
        path = None
        if part in file_flags and i + 1 < len(seg):
            path = seg[i + 1]
        elif part.startswith(("--body-file=", "--description-file=")):
            path = part.split("=", 1)[1]
        if path and path != "-" and "=" not in path and os.path.isfile(path):
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    out.append(fh.read(65536))
            except OSError:
                pass
print("\n".join(out))
' 2>/dev/null
}

PROSE=""
CONTEXT_LABEL=""

if [[ "$MODE" == "file" ]]; then
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

  prosepolice_repo_off -C "${FILE_PATH%/*}" && exit 0

  ADDED=$(agentkit_edit_text)
  [[ -z "$ADDED" ]] && exit 0
  PROSE=$(printf '%s\n' "$ADDED" | strip_code_spans)
  CONTEXT_LABEL="added prose"
else
  prosepolice_repo_off && exit 0
  INLINE_TEXT=$(extract_inline_forge_text) || exit 0
  [[ -z "${INLINE_TEXT//[[:space:]]/}" ]] && exit 0
  PROSE=$(printf '%s\n' "$INLINE_TEXT" | strip_code_spans)
  CONTEXT_LABEL="inline forge text"
fi

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
  # Time of day: the author's clock is not the reader's. Bare "morning" stays
  # legal, because a clock-time example describes the reader's day, not the agent's.
  '\bmorning pass\b'
  '\bmorning briefing\b'
  '\bthis morning\b'
  '\btonight\b'
  '\bthis evening\b'
  '\bthis afternoon\b'
  '\bovernight\b'
  '\blater today\b'
  '\bfirst thing (in the morning|tomorrow|today|tonight)\b'
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
  VIOLATIONS+=("AI-TELL PHRASING in the ${CONTEXT_LABEL}:
${hits}
  These constructions (delve/tapestry vocabulary, significance inflation, negative parallelism, chatbot filler) read as generated text. Say the specific thing plainly instead. Time-of-day naming assumes the reader shares your clock: name the thing by what it does (the daily pass, the reply round, since the last pass), and give an absolute time a zone.")
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
  VIOLATIONS+=("EM-DASH PILE-UP: ${dashes} em dashes in ${words} words of ${CONTEXT_LABEL} (limit: ${MAX_EMDASH_PER_100_WORDS} per 100). Vary the joinery — most of these want a period, a comma, or a plain sentence.")
}

check_slop_phrases
check_emdash_density

if (( ${#VIOLATIONS[@]} > 0 )); then
  REPORT="PROSE DISCIPLINE VIOLATION (prose-police)
==================================================
"
  for i in "${!VIOLATIONS[@]}"; do
    REPORT+="$(( i + 1 )). ${VIOLATIONS[$i]}"$'\n\n'
  done
  if [[ "$MODE" == "file" ]]; then
    QUOTE_REMEDY="- Quoting someone else's words, or code? Put the quotation in backticks or a fenced block — code spans are exempt."
  else
    # In a double-quoted shell argument a backtick is command substitution:
    # advice to add one would execute the quotation instead of posting it.
    QUOTE_REMEDY="- Quoting someone else's words, or code? Code spans (backticks) are exempt — but in a shell command, single-quote the whole body so the backticks stay literal, or pass the text with --body-file."
  fi
  REPORT+="REQUIRED ACTIONS:
- Rewrite the flagged text in plain, specific language (the humanize skill does this wholesale).
${QUOTE_REMEDY}
- State facts directly; cut inflation, hedging, and formula.
- Off switches: AGENTKIT_SKIP_HOOKS=prose-police (session); git config agentkit.prosepolice.enabled false (repo); or in agentkit config.yaml (global), an 'enabled: false' line nested under a 'prose-police:' section.

Fix these before proceeding."

  if [[ "$MODE" == "file" ]]; then
    # Exit 2 is what delivers this. Claude Code discards a PostToolUse
    # hook's stderr at exit 0, so the check ran and nobody heard it.
    printf '\n%s\n' "$REPORT" >&2
    exit 2
  fi
  # PreToolUse refuses by data, not status.
  agentkit_deny_json "$REPORT"
  exit 0
fi

exit 0
