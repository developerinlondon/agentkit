#!/usr/bin/env bash
# One-way sync: top-level sources → the Claude Code plugin (plugins-cc/agentkit).
# The generic units (hooks/claude, skills, selected tools) are the source of truth (ADR #45);
# the plugin wraps them for one-step install. Run after changing either source
# tree and commit the result — the plugin must never be edited directly.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_DIR/plugins-cc/agentkit"
MARKETPLACE="$REPO_DIR/.claude-plugin/marketplace.json"

# shellcheck source=../lib/skill-kits.sh
source "$REPO_DIR/lib/skill-kits.sh"
validate_skill_kits || exit 1

if ! command -v jq >/dev/null 2>&1; then
	echo "[sync] ERROR: jq is required to generate per-kit plugin manifests." >&2
	exit 1
fi

# Hooks: copy scripts only — hooks.json (the plugin's wiring) is plugin-owned.
# The review gate scripts ship in the adversarial-review kit's plugin, not core.
REVIEW_PLUGIN_DIR="$REPO_DIR/plugins-cc/$(kit_plugin_id adversarial-review)"
MEMORY_PLUGIN_DIR="$REPO_DIR/plugins-cc/$(kit_plugin_id memory)"
review_hook_script() {
	case "$(basename "$1")" in
	review-police.sh | fail-closed-hook.sh) return 0 ;;
	esac
	return 1
}
memory_hook_script() {
	case "$(basename "$1")" in
	brain-inject.sh | brain-index.sh) return 0 ;;
	esac
	return 1
}
mkdir -p "$REVIEW_PLUGIN_DIR/hooks" "$REVIEW_PLUGIN_DIR/tools" "$MEMORY_PLUGIN_DIR/hooks"
for hook in "$REPO_DIR"/hooks/claude/*.sh; do
	if review_hook_script "$hook"; then
		cp "$hook" "$REVIEW_PLUGIN_DIR/hooks/$(basename "$hook")"
		rm -f "$PLUGIN_DIR/hooks/$(basename "$hook")"
	elif memory_hook_script "$hook"; then
		cp "$hook" "$MEMORY_PLUGIN_DIR/hooks/$(basename "$hook")"
		rm -f "$PLUGIN_DIR/hooks/$(basename "$hook")"
	else
		cp "$hook" "$PLUGIN_DIR/hooks/$(basename "$hook")"
	fi
done
echo "[sync] hooks/claude/*.sh -> plugins-cc/{agentkit,agentkit-adversarial-review,agentkit-memory}/hooks/"

# Shared helpers (dual Claude/Grok payload parsing). Must live next to the
# scripts so `source "$(dirname …)/lib/hook-input.sh"` resolves.
if [[ -d "$REPO_DIR/hooks/claude/lib" ]]; then
	mkdir -p "$PLUGIN_DIR/hooks/lib" "$REVIEW_PLUGIN_DIR/hooks/lib" "$MEMORY_PLUGIN_DIR/hooks/lib"
	cp -a "$REPO_DIR"/hooks/claude/lib/. "$PLUGIN_DIR/hooks/lib/"
	cp -a "$REPO_DIR"/hooks/claude/lib/. "$REVIEW_PLUGIN_DIR/hooks/lib/"
	cp -a "$REPO_DIR"/hooks/claude/lib/. "$MEMORY_PLUGIN_DIR/hooks/lib/"
	echo "[sync] hooks/claude/lib -> core + review + memory plugin hooks/lib/"
fi

# Skills: one plugin per declared kit, membership straight from the manifest.
# A skill that changed kit must leave its old plugin, or it ships twice.
plugin_dir_for() {
	printf '%s/plugins-cc/%s' "$REPO_DIR" "$(kit_plugin_id "$1")"
}

# A kit plugin's payload is its skills OR hand-wired hooks/tools (the
# adversarial-review gate ships both). No payload: no manifest, no marketplace
# entry, and the prune arm may take the tree.
kit_plugin_has_payload() {
	kit_has_skills "$1" && return 0
	local dir
	dir="$(plugin_dir_for "$1")"
	[[ -d "$dir/hooks" || -d "$dir/tools" ]]
}

for kit in $(declared_kits); do
	kit_has_skills "$kit" || continue
	mkdir -p "$(plugin_dir_for "$kit")/skills"
done

for kit in $(declared_kits); do
	kit_dir="$(plugin_dir_for "$kit")"
	for plugin_skill in "$kit_dir"/skills/*/; do
		[[ -d "$plugin_skill" ]] || continue
		name="$(basename "$plugin_skill")"
		if [[ ! -d "$REPO_DIR/skills/$name" ]] || [[ "$(skill_kit "$name")" != "$kit" ]]; then
			echo "[sync] removing from $(kit_plugin_id "$kit"): $name"
			rm -rf "$plugin_skill"
		fi
	done
done

for skill in "$REPO_DIR"/skills/*/; do
	name="$(basename "$skill")"
	kit_dir="$(plugin_dir_for "$(skill_kit "$name")")"
	rm -rf "$kit_dir/skills/$name"
	cp -r "$skill" "$kit_dir/skills/$name"
done
echo "[sync] skills/* -> plugins-cc/<plugin>/skills/ (by kit)"

# A skill may import a dependency-free module from a skill in another kit.
# Kits install as separate plugins, so that module has to ride along or the
# relative import escapes the plugin boundary and the shipped script cannot
# load at all. Runs after the copy above, whose prune drops it first, so a
# repeat sync lands on the same tree.
carry_leaf() {
	local leaf="$1" consumer="$2" owner_kit consumer_kit dest
	owner_kit="$(skill_kit "${leaf%%/*}")"
	consumer_kit="$(skill_kit "$consumer")"
	if [[ "$owner_kit" == "$consumer_kit" ]]; then
		return 0
	fi
	dest="$(plugin_dir_for "$consumer_kit")/skills/$leaf"
	mkdir -p "$(dirname "$dest")"
	cp "$REPO_DIR/skills/$leaf" "$dest"
	echo "[sync] carried skills/$leaf -> $(kit_plugin_id "$consumer_kit")"
}

carry_leaf publish-page/slides.ts product-intelligence

# Kit plugins other than core carry skills only; core keeps its hand-written
# manifest because it also wires hooks, tools, and MCP servers.
for kit in $(declared_kits); do
	[[ "$kit" == core ]] && continue
	kit_plugin_has_payload "$kit" || continue
	plugin_id="$(kit_plugin_id "$kit")"
	kit_dir="$(plugin_dir_for "$kit")"
	mkdir -p "$kit_dir/.claude-plugin"
	jq --arg name "$plugin_id" --arg description "$(kit_description "$kit")" '{
		"$schema": .["$schema"],
		name: $name,
		version: .version,
		description: $description,
		author: .author,
		skills: "./skills/"
	}' "$PLUGIN_DIR/.claude-plugin/plugin.json" >"$kit_dir/.claude-plugin/plugin.json"
	echo "[sync] generated $plugin_id plugin manifest"
done

# Drop plugin trees for kits the manifest no longer declares, and for a kit
# whose payload left — it would otherwise keep serving skills from a stale copy.
for stale in "$REPO_DIR"/plugins-cc/agentkit-*/; do
	[[ -d "$stale" ]] || continue
	stale_id="$(basename "$stale")"
	if ! kit_declared "${stale_id#agentkit-}" || ! kit_plugin_has_payload "${stale_id#agentkit-}"; then
		echo "[sync] removing dropped kit plugin: $stale_id"
		rm -rf "$stale"
	fi
done

# Marketplace: generated kit entries are owned by this script; the core
# agentkit entry and third-party sources (assay, infra-tools) are not touched.
marketplace_entries="$(
	for kit in $(declared_kits); do
		[[ "$kit" == core ]] && continue
		kit_plugin_has_payload "$kit" || continue
		plugin_id="$(kit_plugin_id "$kit")"
		jq -n --arg name "$plugin_id" \
			--arg source "./plugins-cc/$plugin_id" \
			--arg description "$(kit_description "$kit")" \
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
echo "[sync] kit plugins -> .claude-plugin/marketplace.json"

# Portable tools used by bundled hooks. Keep this allowlist explicit: other
# top-level tools are not necessarily plugin-facing commands.
# shellcheck disable=SC2043 # One entry today; the allowlist is the point, not the loop.
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
	for kit in $(declared_kits); do
		kit_plugin_has_payload "$kit" || continue
		if ! claude plugin validate "$(plugin_dir_for "$kit")"; then
			echo "[sync] ERROR: $(kit_plugin_id "$kit") is not a valid plugin." >&2
			exit 1
		fi
		echo "[sync] $(kit_plugin_id "$kit") manifest valid"
	done
fi

if ! git -C "$REPO_DIR" diff --quiet -- plugins-cc; then
	echo "[sync] plugin updated — review and commit the changes"
else
	echo "[sync] plugin already in sync"
fi
