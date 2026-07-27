# Shared Pre/PostToolUse input helpers for Claude Code and Grok CLI.
# Source from a police hook:
#   # shellcheck source=lib/hook-input.sh
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/hook-input.sh"
#
# Grok sends camelCase (toolName, toolInput, sessionId). Claude sends snake_case.
# Matchers already alias tool names; scripts must still read both key styles and
# treat Grok tool names as their Claude family (Bash/Edit/Write).

_agentkit_jq() {
	if [[ -n "${JQ_BIN:-}" ]]; then
		"$JQ_BIN" "$@"
	else
		jq "$@"
	fi
}

agentkit_slurp_input() {
	if [[ -n "${CAT_BIN:-}" ]]; then
		AGENTKIT_RAW_INPUT=$("$CAT_BIN")
	else
		AGENTKIT_RAW_INPUT=$(cat)
	fi
}

agentkit_jq_raw() {
	printf '%s' "${AGENTKIT_RAW_INPUT:-}" | _agentkit_jq "$@"
}

agentkit_tool_name() {
	agentkit_jq_raw -r '.tool_name // .toolName // empty'
}

agentkit_command() {
	agentkit_jq_raw -r '.tool_input.command // .toolInput.command // empty'
}

agentkit_session_id() {
	agentkit_jq_raw -r '.session_id // .sessionId // "unknown"'
}

agentkit_file_path() {
	agentkit_jq_raw -r '
    .tool_input.file_path // .tool_input.filePath // .tool_input.path //
    .tool_input.target_file // .tool_input.targetFile //
    .toolInput.file_path // .toolInput.filePath // .toolInput.path //
    .toolInput.target_file // .toolInput.targetFile // empty'
}

agentkit_edit_text() {
	agentkit_jq_raw -r '
    .tool_input.new_string // .tool_input.content // .tool_input.newString //
    .toolInput.new_string // .toolInput.content // .toolInput.newString // empty'
}

# Map harness-specific tool names onto Claude's Bash/Edit/Write families so
# case filters and MCP vs shell branches stay correct under Grok.
agentkit_tool_family() {
	local t="${1-}"
	if [[ -z "$t" ]]; then
		t=$(agentkit_tool_name)
	fi
	case "$t" in
	Bash | bash | run_terminal_command | Shell | shell) printf '%s' 'Bash' ;;
	Edit | edit | MultiEdit | multi_edit | search_replace | StrReplace | str_replace) printf '%s' 'Edit' ;;
	Write | write | create_file | Create | create) printf '%s' 'Write' ;;
	*) printf '%s' "$t" ;;
	esac
}

agentkit_is_file_write_tool() {
	case "$(agentkit_tool_family "${1-}")" in
	Edit | Write) return 0 ;;
	*) return 1 ;;
	esac
}

# Dual-emit Claude (hookSpecificOutput) and Grok ({decision, reason}) deny shapes.
agentkit_deny_json() {
	local reason="$1"
	_agentkit_jq -n --arg r "$reason" '{
    decision: "deny",
    reason: $r,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
}

agentkit_advise_json() {
	local msg="$1"
	_agentkit_jq -n --arg m "$msg" '{
    systemMessage: $m,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $m
    }
  }'
}
