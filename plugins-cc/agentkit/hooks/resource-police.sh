#!/bin/bash
set -euo pipefail

# bash 3.2 — stock on macOS — cannot parse `(` inside [[ =~ ]]. Held in
# variables, these parse everywhere and BASH_REMATCH still works.
# A parse error here is fatal: this is a PreToolUse Bash hook, so it would
# deny EVERY command with the kill switch unreachable.
RE_BARE_TASK='^(build|check|type-?check|lint)(:[[:alnum:]_-]+)?$'
RE_BUN_HEAVY='^(add|install|update|test)$'
RE_CARGO_HEAVY='^(build|check|test|clippy)$'
RE_DELEGATING='^(ansible|ansible-playbook|doas|mosh|pkexec|run0|ssh|sudo|systemd-run)$'
RE_DOCKER_READONLY='^(diff|events|history|images|info|inspect|logs|port|ps|stats|top|version)$'
RE_GO_HEAVY='^(build|test)$'
RE_KUBECTL_READONLY='^(api-resources|api-versions|auth|cluster-info|describe|explain|get|logs|top|version)$'
RE_MACHINECTL_READONLY='^(list|show|status)$'
RE_MOON_HEAVY='^(ci|check|run)$'
RE_NPM_HEAVY='^(add|install|i|ci|update|upgrade|test)$'
RE_ORCHESTRATOR='^(buildah|docker|kubectl|machinectl|nerdctl|podman|service|systemctl)$'
RE_BUILDAH_READONLY='^(containers|images|info|inspect|version)$'
RE_SCRIPT_TASK='^(build|check|type-?check|lint|test)(:[[:alnum:]_-]+)?$'
RE_SHELL='^(bash|dash|fish|sh|zsh)$'
RE_SYSTEMCTL_READONLY='^(cat|get-default|is-active|is-enabled|is-failed|list-|show|status)'
RE_UV_HEAVY='^(add|sync)$'
RE_YARN_HEAVY='^(add|install|up|upgrade|test)$'
readonly MAX_ANALYSIS_DEPTH=4


# Absolute paths are deliberate: a hook that inspects a command must not
# resolve its own tools through a PATH that command could have manipulated.
# But the locations are NOT the same everywhere — `cat` is /bin/cat on macOS
# and /usr/bin/cat on most Linux, and jq is wherever it was installed. Probing
# a short list of known locations keeps the intent while working on both.
#
# This mattered: the hardcoded /usr/bin/cat does not exist on macOS, so with
# `set -e` the hook died on its very first line. Claude Code reported only
# "non-blocking status code", which reads as noise — so the guard was not
# merely broken, it was silently OFF while appearing to be installed.
pick_bin() {
	local p
	for p in "$@"; do
		[[ -x "$p" ]] && {
			printf '%s' "$p"
			return 0
		}
	done
	return 1
}

AWK_BIN=$(pick_bin /usr/bin/awk /bin/awk) || AWK_BIN=""
CAT_BIN=$(pick_bin /bin/cat /usr/bin/cat) || CAT_BIN=""
JQ_BIN=$(pick_bin /usr/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq) || JQ_BIN=""
readonly AWK_BIN CAT_BIN JQ_BIN

# Missing tools mean this guard cannot run. Say so ONCE, loudly, and allow the
# command: this is defence-in-depth detection, not a sandbox, so failing closed
# would wedge every Bash call over a missing utility. What must not happen is
# failing silently, which is exactly what it did before.
if [[ -z "$AWK_BIN" || -z "$CAT_BIN" || -z "$JQ_BIN" ]]; then
	printf 'resource-police: DISABLED — missing %s. Heavy commands are NOT being bounded.\n' \
		"$([[ -z "$AWK_BIN" ]] && printf 'awk '; [[ -z "$CAT_BIN" ]] && printf 'cat '; [[ -z "$JQ_BIN" ]] && printf 'jq ')" >&2
	exit 0
fi

# Stand down from LOCAL containment where bounding is impossible, but keep
# parsing commands: delegated work and undecidable nesting remain blocked on
# every platform because neither becomes safe when cgroups are unavailable.
#
# bounded-run contains work in a systemd scope backed by cgroup v2, and dies
# with 'cgroup v2 is unavailable' without it. macOS has neither cgroups nor
# systemd, so enforcing here would deny every heavy command and name a remedy
# that cannot run on this host — a deadlock with no way out except the escape
# hatch, on every build, test and typecheck.
#
# Announced once per session rather than per command: a warning on every Bash
# call is the kind of noise that trains people to ignore hooks, but silently
# disabling a guard is how it stays broken for months.
detect_platform() {
	if [[ -n "${AGENTKIT_PLATFORM:-}" ]]; then
		printf '%s' "$AGENTKIT_PLATFORM"
		return
	fi
	case "$(uname -s 2>/dev/null || true)" in
	Linux) printf 'linux' ;;
	Darwin) printf 'darwin' ;;
	*) printf 'unknown' ;;
	esac
}

PLATFORM="$(detect_platform)"
CONTAINMENT_REQUIRED=0
if [[ "$PLATFORM" == linux && -r /sys/fs/cgroup/cgroup.controllers ]]; then
	CONTAINMENT_REQUIRED=1
else
	# Keyed on PPID — the client process, stable across every hook invocation
	# in one session. $$ is this hook's own pid and changes each time, which
	# would make "once" mean "always".
	notice="${TMPDIR:-/tmp}/.agentkit-resource-police-inactive.$PPID"
	if [[ ! -e "$notice" ]]; then
		: >"$notice" 2>/dev/null || true
		printf 'resource-police: local containment INACTIVE on %s — bounded-run is unavailable. Delegated and undecidable commands remain blocked.\n' "$PLATFORM" >&2
	fi
fi

# shellcheck source=lib/hook-input.sh
# Pure bash dirname: external `dirname` is missing when PATH is empty (the
# missing-jq fail-open probe), and a source failure under set -e would silence
# the gate. BASH_SOURCE is absolute when the harness invokes the script by path.
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)
[[ -z "$COMMAND" ]] && exit 0

# User-approved escape hatch for sanctioned delegated workloads (e.g. an
# approved ansible apply). Heavy commands stay bounded regardless. Works from
# the environment or inline (`AGENTKIT_ALLOW_DELEGATED=1 ansible-playbook …`);
# inline assignments never reach the hook process, so honor them from the text
# (same treatment as AGENTKIT_ALLOW_STALE_PUSH in git-police).
DELEGATED_OK="${AGENTKIT_ALLOW_DELEGATED:-0}"
if printf '%s' "$COMMAND" \
	| grep -qE '(^|[[:space:];&|])AGENTKIT_ALLOW_DELEGATED=1([[:space:];&|]|$)'; then
	DELEGATED_OK=1
fi

deny() {
	local segment="$1"
	local kind="${2:-heavy}"
	local reason
	local runner_hint=bounded-run
	if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -x "$CLAUDE_PLUGIN_ROOT/tools/bounded-run" ]]; then
		runner_hint="$CLAUDE_PLUGIN_ROOT/tools/bounded-run"
	elif [[ -x "$PWD/.claude/tools/bounded-run" ]]; then
		runner_hint="$PWD/.claude/tools/bounded-run"
	fi
	if [[ "$kind" == untrusted_runner ]]; then
		reason="BLOCKED: that is not a recognised bounded-run: $segment. Anything can be named \`bounded-run\`, so it is trusted by INSTALLED PATH, not by name — otherwise a spoof could silently neuter every limit. AGENTKIT_ALLOW_DELEGATED=1 does NOT clear this. Install the runner (\`~/.local/bin/bounded-run\`) and invoke it from there, or use the plugin's copy under \$CLAUDE_PLUGIN_ROOT/tools/. In a fresh clone of agentkit itself, install it first rather than running ./tools/bounded-run in place."
	elif [[ "$kind" == delegated ]]; then
		reason="BLOCKED: delegated workload cannot be contained by bounded-run: $segment. Use a separately approved dedicated runner or verified engine-native limits. User-approved delegated workloads: prefix with AGENTKIT_ALLOW_DELEGATED=1."
	elif [[ "$kind" == undecidable ]]; then
		reason="BLOCKED: command could not be analyzed safely: $segment. Wrapper or shell nesting exceeded the $MAX_ANALYSIS_DEPTH-level analysis bound."
	else
		reason="BLOCKED: resource-intensive command is not contained: $segment. Run it through $runner_hint, for example: $runner_hint --profile compile -- bun run typecheck. Use profile browser for Playwright and browser builds."
	fi
	agentkit_deny_json "$reason"
	exit 0
}

split_segments() {
	"$AWK_BIN" '
    function emit() {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", segment)
      if (length(segment)) print segment
      segment = ""
    }
    {
      for (position = 1; position <= length($0); position++) {
        character = substr($0, position, 1)
        next_character = substr($0, position + 1, 1)
        if (escaped) {
          segment = segment character
          escaped = 0
          continue
        }
        if (character == "\\" && !single_quote) {
          segment = segment character
          escaped = 1
          continue
        }
        if (character == sprintf("%c", 39) && !double_quote) {
          single_quote = !single_quote
          segment = segment character
          continue
        }
        if (character == "\"" && !single_quote) {
          double_quote = !double_quote
          segment = segment character
          continue
        }
        pair = character next_character
        if (!single_quote && !double_quote &&
            (character == ";" || character == "|" || character == "&" ||
             character == "(" || character == ")" || character == "{" ||
             character == "}" || pair == "&&")) {
          emit()
          if (pair == "&&" || pair == "||") position++
          continue
        }
        segment = segment character
      }
      if (!single_quote && !double_quote) emit()
      else segment = segment "\n"
    }
    END { emit() }
  '
}

parse_launch() {
	local segment="$1"
	local token
	local index=0
	local wrapper_depth=0
	PARSE_UNDECIDABLE=0
	read -r -a TOKENS <<<"$segment"
	while [[ -n "${TOKENS[$index]:-}" ]]; do
		while [[ "${TOKENS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
			index=$((index + 1))
		done
		token="${TOKENS[$index]:-}"
		token="${token//\"/}"
		token="${token//\'/}"
		case "${token##*/}" in
		sudo | doas | pkexec | run0)
			EXECUTABLE="${token##*/}"
			ARGS=("${TOKENS[@]:$((index + 1))}")
			return 0
			;;
		env)
			wrapper_depth=$((wrapper_depth + 1))
			if ((wrapper_depth > MAX_ANALYSIS_DEPTH)); then
				PARSE_UNDECIDABLE=1
				return 0
			fi
			index=$((index + 1))
			while [[ "${TOKENS[$index]:-}" == -* \
				|| "${TOKENS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
				index=$((index + 1))
			done
			;;
		command | nohup | time)
			wrapper_depth=$((wrapper_depth + 1))
			if ((wrapper_depth > MAX_ANALYSIS_DEPTH)); then
				PARSE_UNDECIDABLE=1
				return 0
			fi
			index=$((index + 1))
			while [[ "${TOKENS[$index]:-}" == -* ]]; do index=$((index + 1)); done
			;;
		*) break ;;
		esac
	done
	token="${TOKENS[$index]:-}"
	token="${token//\"/}"
	token="${token//\'/}"
	EXECUTABLE="${token##*/}"
	EXECUTABLE_TOKEN="$token"
	ARGS=("${TOKENS[@]:$((index + 1))}")
}

is_heavy() {
	# `${VAR,,}` is bash 4+. macOS ships bash 3.2 at /bin/bash, which this
	# script's shebang selects, so that expansion is a hard parse error there —
	# and with `set -e` it killed the hook mid-run, leaving the guard off. `tr`
	# is portable and the cost is irrelevant at one call per command.
	local executable
	executable=$(printf '%s' "$EXECUTABLE" | LC_ALL=C tr '[:upper:]' '[:lower:]')
	local first="${ARGS[0]:-}"
	local second="${ARGS[1]:-}"
	case "$executable" in
	bun)
		[[ "$first" =~ $RE_BUN_HEAVY ]] && return 0
		[[ "$first" == run && "$second" =~ $RE_SCRIPT_TASK ]]
		;;
	bunx | npx)
		[[ "$first" == tsc && "$second" != --version ]] \
			|| [[ "$first" == playwright && "$second" == test ]]
		;;
	npm | pnpm)
		[[ "$first" =~ $RE_NPM_HEAVY ]] && return 0
		[[ "$first" == run && "$second" =~ $RE_SCRIPT_TASK ]]
		;;
	yarn)
		[[ -z "$first" ]] && return 0
		[[ "$first" =~ $RE_YARN_HEAVY ]] && return 0
		[[ "$first" == run && "$second" =~ $RE_SCRIPT_TASK ]] && return 0
		[[ "$first" =~ $RE_BARE_TASK ]]
		;;
	tsc) [[ "$first" != --version ]] ;;
	playwright) [[ "$first" == test ]] ;;
	cargo) [[ "$first" =~ $RE_CARGO_HEAVY ]] ;;
	go) [[ "$first" =~ $RE_GO_HEAVY ]] ;;
	moon) [[ "$first" =~ $RE_MOON_HEAVY ]] ;;
	pip | pip3) [[ "$first" == install ]] ;;
	uv)
		[[ "$first" =~ $RE_UV_HEAVY ]] && return 0
		[[ "$first" == pip && "$second" == install ]] && return 0
		[[ "$first" == run && "$second" == pytest ]]
		;;
	pytest) return 0 ;;
	python | python3) [[ "$first" == -m && "$second" == pytest ]] ;;
	*) return 1 ;;
	esac
}

shell_command_payload() {
	PAYLOAD=''
	local index argument
	for index in "${!ARGS[@]}"; do
		argument="${ARGS[$index]}"
		if [[ "$argument" == --command=* ]]; then
			PAYLOAD="${argument#--command=} ${ARGS[*]:$((index + 1))}"
		elif [[ "$argument" == --command ]] \
			|| [[ "$argument" != --* && "$argument" == -*c* ]]; then
			PAYLOAD="${ARGS[*]:$((index + 1))}"
		else
			continue
		fi
		PAYLOAD="${PAYLOAD//\'/}"
		PAYLOAD="${PAYLOAD//\"/}"
		return 0
	done
	return 1
}

is_delegating() {
	[[ "$EXECUTABLE" =~ $RE_DELEGATING ]] && return 0
	if [[ "$EXECUTABLE" =~ $RE_ORCHESTRATOR ]]; then
		is_read_only_diagnostic && return 1
		return 0
	fi
	if [[ "$EXECUTABLE" =~ $RE_SHELL ]]; then
		shell_command_payload && return 0
	fi
	return 1
}

is_read_only_diagnostic() {
	local first='' second='' argument
	for argument in "${ARGS[@]+"${ARGS[@]}"}"; do
		[[ "$argument" == -* ]] && continue
		if [[ -z "$first" ]]; then
			first="$argument"
			continue
		fi
		second="$argument"
		break
	done
	case "$EXECUTABLE" in
	systemctl) [[ "$first" =~ $RE_SYSTEMCTL_READONLY ]] ;;
	kubectl) [[ "$first" =~ $RE_KUBECTL_READONLY ]] ;;
	docker | nerdctl | podman) [[ "$first" =~ $RE_DOCKER_READONLY ]] ;;
	buildah) [[ "$first" =~ $RE_BUILDAH_READONLY ]] ;;
	machinectl) [[ "$first" =~ $RE_MACHINECTL_READONLY ]] ;;
	service) [[ "$second" == status ]] ;;
	*) return 1 ;;
	esac
}

is_trusted_runner() {
	# agentkit-run is the pre-rename compat alias installed as a symlink.
	case "$EXECUTABLE_TOKEN" in
	bounded-run | '$HOME/.local/bin/bounded-run' | '~/.local/bin/bounded-run' | ./.claude/tools/bounded-run)
		return 0
		;;
	agentkit-run | '$HOME/.local/bin/agentkit-run' | '~/.local/bin/agentkit-run' | ./.claude/tools/agentkit-run)
		return 0
		;;
	/home/*/.local/bin/bounded-run | */plugins/*/tools/bounded-run) return 0 ;;
	/home/*/.local/bin/agentkit-run | */plugins/*/tools/agentkit-run) return 0 ;;
	*) return 1 ;;
	esac
}

unwrap_environment() {
	local index=0
	[[ "$EXECUTABLE" == env ]] || return 0
	while [[ "${ARGS[$index]:-}" == -* \
		|| "${ARGS[$index]:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do
		index=$((index + 1))
	done
	[[ -n "${ARGS[$index]:-}" ]] || return 0
	EXECUTABLE="${ARGS[$index]##*/}"
	ARGS=("${ARGS[@]:$((index + 1))}")
}

parse_wrapped_command() {
	local index
	WRAPPED_COMMAND=''
	for index in "${!ARGS[@]}"; do
		if [[ "${ARGS[$index]}" == -- && -n "${ARGS[$((index + 1))]:-}" ]]; then
			WRAPPED_COMMAND="${ARGS[*]:$((index + 1))}"
			return 0
		fi
	done
	return 1
}

analyze_command() {
	local command="$1"
	local depth="$2"
	local contained="${3:-0}"
	local segments segment
	((depth <= MAX_ANALYSIS_DEPTH)) \
		|| deny "shell or wrapper nesting exceeds analysis depth: $command" undecidable
	segments=$(printf '%s\n' "$command" | split_segments) \
		|| deny 'command could not be parsed safely' undecidable
	while IFS= read -r segment; do
		[[ -n "$segment" ]] || continue
		parse_launch "$segment"
		if [[ "$PARSE_UNDECIDABLE" == 1 ]]; then deny "$segment" undecidable; fi
		if [[ "$EXECUTABLE" == bounded-run || "$EXECUTABLE" == agentkit-run ]]; then
			# NOT `delegated`: that message advertises AGENTKIT_ALLOW_DELEGATED=1,
			# which this branch never consults, so it sent people chasing an
			# escape hatch that cannot clear it. The actual problem is that this
			# path is not a recognised runner — anything can be named
			# `bounded-run`, and trusting it by name alone would let a spoof
			# neuter every limit.
			local trusted_runner=0
			is_trusted_runner && trusted_runner=1
			if parse_wrapped_command; then
				local nested_command="$WRAPPED_COMMAND"
				parse_launch "$nested_command"
				if [[ "$PARSE_UNDECIDABLE" == 1 ]]; then deny "$segment" undecidable; fi
				if is_delegating && [[ "$DELEGATED_OK" != 1 ]]; then deny "$segment" delegated; fi
				analyze_command "$nested_command" $((depth + 1)) 1
			fi
			if [[ "$CONTAINMENT_REQUIRED" == 1 && "$trusted_runner" != 1 ]]; then
				deny "$segment" untrusted_runner
			fi
			continue
		fi
		if [[ "$EXECUTABLE" =~ $RE_SHELL ]] && shell_command_payload; then
			analyze_command "$PAYLOAD" $((depth + 1)) "$contained"
			continue
		fi
		if is_delegating && [[ "$DELEGATED_OK" != 1 ]]; then
			deny "$segment" delegated
		fi
		if [[ "$CONTAINMENT_REQUIRED" == 1 && "$contained" != 1 ]] && is_heavy; then
			deny "$segment"
		fi
	done <<<"$segments"
}

declare EXECUTABLE EXECUTABLE_TOKEN PARSE_UNDECIDABLE PAYLOAD WRAPPED_COMMAND
declare -a TOKENS ARGS
analyze_command "$COMMAND" 0

exit 0
