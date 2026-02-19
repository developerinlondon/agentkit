#!/usr/bin/env bash
# kubectl-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: kubectl create/apply on Kargo CRDs
# Equivalent to: plugins/kubectl-police.ts (OpenCode)
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[[ -z "$COMMAND" ]] && exit 0

deny() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# Check for kubectl create/apply on Kargo CRDs
if echo "$COMMAND" | grep -qiE '\bkubectl\b.*\b(create|apply)\b'; then
  KARGO_CRDS="promotion|promotions|stage|stages|freight|freights|warehouse|warehouses"
  if echo "$COMMAND" | grep -qiE "\b(${KARGO_CRDS})\b"; then
    # Extract which CRD was matched
    CRD=$(echo "$COMMAND" | grep -oiE "\b(${KARGO_CRDS})\b" | head -1 | tr '[:upper:]' '[:lower:]')
    deny "BLOCKED: Creating/applying Kargo ${CRD} via kubectl is forbidden. kubectl-created Kargo resources poison the stage state machine: Promotions get custom names that break lexicographic sorting, currentPromotion not set. Stages become orphaned state that ArgoCD can't reconcile. Use instead: Kargo UI or auto-promotion for promotions, GitOps (git push) for stage/warehouse/freight changes, kubectl DELETE (not create) to recover from corrupted state."
  fi
fi

exit 0
