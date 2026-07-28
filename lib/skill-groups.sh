#!/usr/bin/env bash
# Readers for skills/GROUPS, shared by install.sh and scripts/sync-cc-plugin.sh
# so the installer and the plugin generator can never disagree about which skill
# belongs to which group. Callers set SKILL_GROUPS_FILE or REPO_DIR first.

SKILL_GROUPS_FILE="${SKILL_GROUPS_FILE:-${REPO_DIR:-.}/skills/GROUPS}"

declared_groups() {
	awk '$1 == "group" && NF >= 2 { print $2 }' "$SKILL_GROUPS_FILE"
}

group_description() {
	awk -v want="$1" '$1 == "group" && $2 == want {
		$1 = ""; $2 = ""; sub(/^[ \t]+/, ""); print; exit
	}' "$SKILL_GROUPS_FILE"
}

group_declared() {
	declared_groups | grep -Fxq "$1"
}

skill_group() {
	local name="$1" entry group
	while read -r entry group _; do
		case "$entry" in '' | '#'* | group) continue ;; esac
		if [[ "$entry" == "$name" && -n "$group" ]]; then
			printf '%s' "$group"
			return 0
		fi
	done <"$SKILL_GROUPS_FILE"
	printf 'core'
}

assigned_groups() {
	awk '$1 != "group" && $1 !~ /^#/ && NF >= 2 { print $2 }' "$SKILL_GROUPS_FILE" | sort -u
}

# One plugin per group, named from the manifest: core ships as `agentkit`, every
# other group as `agentkit-<group>`.
group_plugin_id() {
	if [[ "$1" == core ]]; then
		printf 'agentkit'
	else
		printf 'agentkit-%s' "$1"
	fi
}

# A membership naming an undeclared group would make that skill uninstallable by
# any flag — the one manifest typo no other check can catch.
validate_skill_groups() {
	if [[ ! -f "$SKILL_GROUPS_FILE" ]]; then
		echo "ERROR: missing $SKILL_GROUPS_FILE — cannot resolve skill groups." >&2
		return 1
	fi
	local group
	for group in $(assigned_groups); do
		if ! group_declared "$group"; then
			echo "ERROR: $SKILL_GROUPS_FILE assigns skills to undeclared group '$group'." >&2
			return 1
		fi
	done
}
