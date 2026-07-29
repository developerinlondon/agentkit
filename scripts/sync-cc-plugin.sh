#!/usr/bin/env bash
# One-way sync: top-level sources → the Claude Code plugin (plugins-cc/agentkit).
# The generic units (hooks/claude, skills, selected tools) are the source of truth (ADR #45);
# the plugin wraps them for one-step install. Run after changing either source
# tree and commit the result — the plugin must never be edited directly.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_DIR/plugins-cc/agentkit"
MARKETPLACE="$REPO_DIR/.claude-plugin/marketplace.json"

# shellcheck source=../lib/skill-groups.sh
source "$REPO_DIR/lib/skill-groups.sh"
validate_skill_groups || exit 1

if ! command -v jq >/dev/null 2>&1; then
	echo "[sync] ERROR: jq is required to generate per-group plugin manifests." >&2
	exit 1
fi

# Hooks: copy scripts only — hooks.json (the plugin's wiring) is plugin-owned.
# The review gate scripts ship in the agentkit-review plugin, not core.
REVIEW_PLUGIN_DIR="$REPO_DIR/plugins-cc/agentkit-review"
review_hook_script() {
	case "$(basename "$1")" in
	review-police.sh | fail-closed-hook.sh) return 0 ;;
	esac
	return 1
}
mkdir -p "$REVIEW_PLUGIN_DIR/hooks" "$REVIEW_PLUGIN_DIR/tools"
for hook in "$REPO_DIR"/hooks/claude/*.sh; do
	if review_hook_script "$hook"; then
		cp "$hook" "$REVIEW_PLUGIN_DIR/hooks/$(basename "$hook")"
		rm -f "$PLUGIN_DIR/hooks/$(basename "$hook")"
	else
		cp "$hook" "$PLUGIN_DIR/hooks/$(basename "$hook")"
	fi
done
echo "[sync] hooks/claude/*.sh -> plugins-cc/{agentkit,agentkit-review}/hooks/"

# Shared helpers (dual Claude/Grok payload parsing). Must live next to the
# scripts so `source "$(dirname …)/lib/hook-input.sh"` resolves.
if [[ -d "$REPO_DIR/hooks/claude/lib" ]]; then
	mkdir -p "$PLUGIN_DIR/hooks/lib" "$REVIEW_PLUGIN_DIR/hooks/lib"
	cp -a "$REPO_DIR"/hooks/claude/lib/. "$PLUGIN_DIR/hooks/lib/"
	cp -a "$REPO_DIR"/hooks/claude/lib/. "$REVIEW_PLUGIN_DIR/hooks/lib/"
	echo "[sync] hooks/claude/lib -> core + review plugin hooks/lib/"
fi

# Skills: one plugin per declared group, membership straight from the manifest.
# A skill that changed group must leave its old plugin, or it ships twice.
plugin_dir_for() {
	printf '%s/plugins-cc/%s' "$REPO_DIR" "$(group_plugin_id "$1")"
}

for group in $(declared_groups); do
	mkdir -p "$(plugin_dir_for "$group")/skills"
done

for group in $(declared_groups); do
	group_dir="$(plugin_dir_for "$group")"
	for plugin_skill in "$group_dir"/skills/*/; do
		[[ -d "$plugin_skill" ]] || continue
		name="$(basename "$plugin_skill")"
		if [[ ! -d "$REPO_DIR/skills/$name" ]] || [[ "$(skill_group "$name")" != "$group" ]]; then
			echo "[sync] removing from $(group_plugin_id "$group"): $name"
			rm -rf "$plugin_skill"
		fi
	done
done

for skill in "$REPO_DIR"/skills/*/; do
	name="$(basename "$skill")"
	group_dir="$(plugin_dir_for "$(skill_group "$name")")"
	rm -rf "$group_dir/skills/$name"
	cp -r "$skill" "$group_dir/skills/$name"
done
echo "[sync] skills/* -> plugins-cc/<plugin>/skills/ (by group)"

# A skill may import a dependency-free module from a skill in another group.
# Groups install as separate plugins, so that module has to ride along or the
# relative import escapes the plugin boundary and the shipped script cannot
# load at all. Runs after the copy above, whose prune drops it first, so a
# repeat sync lands on the same tree.
carry_leaf() {
	local leaf="$1" consumer="$2" owner_group consumer_group dest
	owner_group="$(skill_group "${leaf%%/*}")"
	consumer_group="$(skill_group "$consumer")"
	if [[ "$owner_group" == "$consumer_group" ]]; then
		return 0
	fi
	dest="$(plugin_dir_for "$consumer_group")/skills/$leaf"
	mkdir -p "$(dirname "$dest")"
	cp "$REPO_DIR/skills/$leaf" "$dest"
	echo "[sync] carried skills/$leaf -> $(group_plugin_id "$consumer_group")"
}

carry_leaf publish-page/slides.ts product-intelligence

# Group plugins other than core carry skills only; core keeps its hand-written
# manifest because it also wires hooks, tools, and MCP servers.
for group in $(declared_groups); do
	[[ "$group" == core ]] && continue
	plugin_id="$(group_plugin_id "$group")"
	group_dir="$(plugin_dir_for "$group")"
	mkdir -p "$group_dir/.claude-plugin"
	jq --arg name "$plugin_id" --arg description "$(group_description "$group")" '{
		"$schema": .["$schema"],
		name: $name,
		version: .version,
		description: $description,
		author: .author,
		skills: "./skills/"
	}' "$PLUGIN_DIR/.claude-plugin/plugin.json" >"$group_dir/.claude-plugin/plugin.json"
	echo "[sync] generated $plugin_id plugin manifest"
done

# Drop plugin trees for groups the manifest no longer declares.
for stale in "$REPO_DIR"/plugins-cc/agentkit-*/; do
	[[ -d "$stale" ]] || continue
	stale_id="$(basename "$stale")"
	if ! group_declared "${stale_id#agentkit-}"; then
		echo "[sync] removing dropped group plugin: $stale_id"
		rm -rf "$stale"
	fi
done

# Marketplace: generated group entries are owned by this script; the core
# agentkit entry and third-party sources (assay, infra-tools) are not touched.
marketplace_entries="$(
	for group in $(declared_groups); do
		[[ "$group" == core ]] && continue
		plugin_id="$(group_plugin_id "$group")"
		jq -n --arg name "$plugin_id" \
			--arg source "./plugins-cc/$plugin_id" \
			--arg description "$(group_description "$group")" \
			--arg version "$(jq -r .version "$PLUGIN_DIR/.claude-plugin/plugin.json")" \
			'{name: $name, source: $source, description: $description, version: $version}'
	done | jq -s '.'
)"
jq --argjson generated "$marketplace_entries" '
	.plugins = (
		[.plugins[] | select(.name | startswith("agentkit-") | not)] + $generated
	)
' "$MARKETPLACE" >"$MARKETPLACE.tmp"
mv "$MARKETPLACE.tmp" "$MARKETPLACE"
echo "[sync] group plugins -> .claude-plugin/marketplace.json"

# Portable tools used by bundled hooks. Keep this allowlist explicit: other
# top-level tools are not necessarily plugin-facing commands.
for tool in bounded-run; do
	cp "$REPO_DIR/tools/$tool" "$PLUGIN_DIR/tools/$tool"
	chmod +x "$PLUGIN_DIR/tools/$tool"
done
for tool in review-gate review-profile; do
	cp "$REPO_DIR/tools/$tool" "$REVIEW_PLUGIN_DIR/tools/$tool"
	chmod +x "$REVIEW_PLUGIN_DIR/tools/$tool"
	rm -f "$PLUGIN_DIR/tools/$tool"
done
echo "[sync] portable hook tools -> core (bounded-run) + review plugin (gate, profile)"

# Fail loudly if the result is an invalid plugin (best-effort: needs claude CLI).
if command -v claude &>/dev/null; then
	for group in $(declared_groups); do
		if ! claude plugin validate "$(plugin_dir_for "$group")"; then
			echo "[sync] ERROR: $(group_plugin_id "$group") is not a valid plugin." >&2
			exit 1
		fi
		echo "[sync] $(group_plugin_id "$group") manifest valid"
	done
fi

if ! git -C "$REPO_DIR" diff --quiet -- plugins-cc; then
	echo "[sync] plugin updated — review and commit the changes"
else
	echo "[sync] plugin already in sync"
fi
