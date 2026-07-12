#!/usr/bin/env bash
# chime.sh — audible nudge when Claude Code needs the human.
#
# Wired as a Notification hook (permission prompt / question waiting → a
# springy "boing") and a Stop hook (turn finished, reply awaiting you → a
# soft ping) so you hear it when you're not looking at the terminal.
#
# Toggle off without editing settings:
#   touch ~/.claude/.chime-off      # mute
#   rm ~/.claude/.chime-off         # unmute
# or export CLAUDE_CHIME=0 in the environment.
#
# Usage: chime.sh [attention|done]   (default: attention)

[ "${CLAUDE_CHIME:-1}" = "0" ] && exit 0
[ -f "$HOME/.claude/.chime-off" ] && exit 0

kind="${1:-attention}"

# macOS: "Sosumi" is the springiest stock sound — distinctive enough to
# register as "Claude needs me" from across the room (Funk and Frog are the
# other boingy options under /System/Library/Sounds/).
if command -v afplay >/dev/null 2>&1; then
  case "$kind" in
    done) afplay /System/Library/Sounds/Ping.aiff >/dev/null 2>&1 ;;
    *) afplay /System/Library/Sounds/Sosumi.aiff >/dev/null 2>&1 ;;
  esac
  exit 0
fi

# Linux: freedesktop sound theme via PulseAudio/PipeWire, if present.
if command -v paplay >/dev/null 2>&1; then
  base=/usr/share/sounds/freedesktop/stereo
  case "$kind" in
    done) f="$base/complete.oga" ;;
    *) f="$base/bell.oga" ;;
  esac
  [ -f "$f" ] && paplay "$f" >/dev/null 2>&1 && exit 0
fi

# Last resort: the terminal bell.
printf '\a'
exit 0
