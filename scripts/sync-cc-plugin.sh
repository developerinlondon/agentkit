#!/usr/bin/env bash
# One-way sync: top-level sources → the Claude Code plugin (plugins-cc/agentkit).
# The generic units (hooks/claude, skills, selected tools) are the source of truth (ADR #45);
# the plugin wraps them for one-step install. Run after changing either source
# tree and commit the result — the plugin must never be edited directly.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_DIR/plugins-cc/agentkit"

# Hooks: copy scripts only — hooks.json (the plugin's wiring) is plugin-owned.
for hook in "$REPO_DIR"/hooks/claude/*.sh; do
	cp "$hook" "$PLUGIN_DIR/hooks/$(basename "$hook")"
done
echo "[sync] hooks/claude/*.sh -> plugins-cc/agentkit/hooks/"

# Shared helpers (dual Claude/Grok payload parsing). Must live next to the
# scripts so `source "$(dirname …)/lib/hook-input.sh"` resolves.
if [[ -d "$REPO_DIR/hooks/claude/lib" ]]; then
	mkdir -p "$PLUGIN_DIR/hooks/lib"
	cp -a "$REPO_DIR"/hooks/claude/lib/. "$PLUGIN_DIR/hooks/lib/"
	echo "[sync] hooks/claude/lib -> plugins-cc/agentkit/hooks/lib/"
fi

# Skills: full mirror — remove skills that no longer exist at top level.
for plugin_skill in "$PLUGIN_DIR"/skills/*/; do
	name="$(basename "$plugin_skill")"
	if [[ ! -d "$REPO_DIR/skills/$name" ]]; then
		echo "[sync] removing dropped skill: $name"
		rm -rf "$plugin_skill"
	fi
done
for skill in "$REPO_DIR"/skills/*/; do
	name="$(basename "$skill")"
	rm -rf "$PLUGIN_DIR/skills/$name"
	cp -r "$skill" "$PLUGIN_DIR/skills/$name"
done
echo "[sync] skills/* -> plugins-cc/agentkit/skills/"

# Portable tools used by bundled hooks. Keep this allowlist explicit: other
# top-level tools are not necessarily plugin-facing commands.
for tool in bounded-run review-gate review-profile; do
	cp "$REPO_DIR/tools/$tool" "$PLUGIN_DIR/tools/$tool"
	chmod +x "$PLUGIN_DIR/tools/$tool"
done
echo "[sync] portable hook tools -> plugins-cc/agentkit/tools/"

# Fail loudly if the result is an invalid plugin (best-effort: needs claude CLI).
if command -v claude &>/dev/null; then
	claude plugin validate "$PLUGIN_DIR" && echo "[sync] plugin manifest valid"
fi

if ! git -C "$REPO_DIR" diff --quiet -- plugins-cc/agentkit; then
	echo "[sync] plugin updated — review and commit the changes"
else
	echo "[sync] plugin already in sync"
fi
