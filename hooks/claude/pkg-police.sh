#!/usr/bin/env bash
# pkg-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks package-manager commands that disagree with the project's manager
# Equivalent to: plugins/pkg-police.ts (OpenCode)
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────
AGENTKIT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"

CONFIG_MANAGER=""
CONFIG_ENABLED=""

load_config() {
  [[ -f "$AGENTKIT_CONFIG" ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      manager) CONFIG_MANAGER="$value" ;;
      enabled) CONFIG_ENABLED="$value" ;;
    esac
  done < <(awk '
    /^[^[:space:]#]/ {
      in_section = ($0 ~ /^pkg-police:/)
      next
    }
    in_section {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (line !~ /^(manager|enabled):[[:space:]]*[^[:space:]#]+([[:space:]]*#.*)?$/) next
      key = line
      sub(/:.*/, "", key)
      sub(/^[^:]*:[[:space:]]*/, "", line)
      sub(/[[:space:]#].*$/, "", line)
      print key "=" tolower(line)
    }
  ' "$AGENTKIT_CONFIG")
}

ENFORCED=""
REASON=""

# The hook payload carries no reliable cwd, so lockfile detection starts at the
# shell's own directory and stops at the git root — a lockfile outside the
# repository says nothing about this project.
detect_from_lockfile() {
  local dir="$PWD" entry mgr lock hit lockname parent
  while :; do
    hit=""
    lockname=""
    for entry in bun:bun.lock bun:bun.lockb npm:package-lock.json \
      pnpm:pnpm-lock.yaml yarn:yarn.lock; do
      mgr="${entry%%:*}"
      lock="${entry#*:}"
      [[ -e "$dir/$lock" ]] || continue
      if [[ -z "$hit" ]]; then
        hit="$mgr"
        lockname="$lock"
      elif [[ "$hit" != "$mgr" ]]; then
        return 1
      fi
    done
    if [[ -n "$hit" ]]; then
      ENFORCED="$hit"
      REASON="this project uses $hit ($lockname)"
      return 0
    fi
    [[ -e "$dir/.git" ]] && return 1
    [[ "$dir" == "/" || -z "$dir" ]] && return 1
    parent="${dir%/*}"
    [[ -z "$parent" ]] && parent="/"
    dir="$parent"
  done
}

resolve_manager() {
  case "$CONFIG_MANAGER" in
    bun | npm | pnpm | yarn)
      ENFORCED="$CONFIG_MANAGER"
      REASON="agentkit config sets pkg-police.manager: $CONFIG_MANAGER"
      return 0
      ;;
    off) return 1 ;;
    auto | '') ;;
    *) return 1 ;;
  esac
  [[ -z "$CONFIG_MANAGER" && "$CONFIG_ENABLED" == "false" ]] && return 1
  detect_from_lockfile
}

# ── Command classification ──────────────────────────────────────────────────
BOUND='[^[:alnum:]_-]'
ARG='([[:space:]]+([^-[:space:]][^[:space:]]*))?'

DETECTED_LABEL=""
DETECTED_ACTION=""

action_for() {
  local sub="$1" arg="$2"
  case "$sub" in
    install | i | ci | '')
      [[ -n "$arg" ]] && printf 'add' || printf 'install'
      ;;
    add) printf 'add' ;;
    exec | dlx | x) printf 'exec' ;;
    run | test | init | publish | create) printf '%s' "$sub" ;;
    *) printf 'run' ;;
  esac
}

# npm and bun are runtimes too, so only their package-management subcommands
# count; pnpm and yarn are package managers whatever the subcommand.
subcommand_is_managed() {
  case "$1:$2" in
    npm:install | npm:i | npm:ci | npm:add | npm:run | npm:test | npm:init | npm:publish | npm:exec | npm:create) return 0 ;;
    bun:install | bun:i | bun:add | bun:run | bun:test | bun:init | bun:publish | bun:create | bun:x) return 0 ;;
    *) return 1 ;;
  esac
}

detect_invocation() {
  local cmd="$1" skip="$2" mgr sub arg exe re
  for mgr in npm bun; do
    [[ "$mgr" == "$skip" ]] && continue
    exe="npx"
    [[ "$mgr" == bun ]] && exe="bunx"
    re="(^|$BOUND)${exe}[[:space:]]"
    if [[ "$cmd" =~ $re ]]; then
      DETECTED_LABEL="$exe"
      DETECTED_ACTION="exec"
      return 0
    fi
    re="(^|$BOUND)${mgr}[[:space:]]+([[:alnum:]:@._-]+)$ARG"
    if [[ "$cmd" =~ $re ]]; then
      sub="${BASH_REMATCH[2]}"
      arg="${BASH_REMATCH[4]}"
      subcommand_is_managed "$mgr" "$sub" || continue
      DETECTED_LABEL="$mgr $sub"
      DETECTED_ACTION=$(action_for "$sub" "$arg")
      return 0
    fi
  done
  for mgr in pnpm yarn; do
    [[ "$mgr" == "$skip" ]] && continue
    re="(^|$BOUND)${mgr}([[:space:]]+([[:alnum:]:@._-]+))?$ARG($|$BOUND)"
    if [[ "$cmd" =~ $re ]]; then
      sub="${BASH_REMATCH[3]}"
      arg="${BASH_REMATCH[5]}"
      DETECTED_LABEL="$mgr${sub:+ $sub}"
      DETECTED_ACTION=$(action_for "$sub" "$arg")
      return 0
    fi
  done
  return 1
}

equivalent() {
  local mgr="$1" action="$2"
  if [[ "$action" == "exec" ]]; then
    case "$mgr" in
      npm) printf 'npx' ;;
      bun) printf 'bunx' ;;
      *) printf '%s dlx' "$mgr" ;;
    esac
    return 0
  fi
  printf '%s %s' "$mgr" "$action"
}

# shellcheck source=lib/hook-input.sh
# Pure bash dirname: external `dirname` is missing when PATH is empty (the
# missing-jq fail-open probe), and a source failure under set -e would silence
# the gate. BASH_SOURCE is absolute when the harness invokes the script by path.
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)

[[ -z "$COMMAND" ]] && exit 0

# User-approved escape hatch for tools that only work with another manager.
# Works from the environment or inline (`AGENTKIT_ALLOW_PKG=1 npm ci`) —
# inline assignments never reach the hook process, so honor them from the
# text (same treatment as AGENTKIT_ALLOW_STALE_PUSH in git-police).
PKG_OK="${AGENTKIT_ALLOW_PKG:-0}"
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])AGENTKIT_ALLOW_PKG=1([[:space:];&|]|$)'; then
  PKG_OK=1
fi
[[ "$PKG_OK" == "1" ]] && exit 0

load_config
resolve_manager || exit 0

detect_invocation "$COMMAND" "$ENFORCED" || exit 0

agentkit_deny_json "BLOCKED: '$DETECTED_LABEL' — $REASON. Use '$(equivalent "$ENFORCED" "$DETECTED_ACTION")'. Override (only when the user approves): prefix with AGENTKIT_ALLOW_PKG=1."
exit 0
