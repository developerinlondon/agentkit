#!/usr/bin/env bash
# Readers for skills/GROUPS, shared by install.sh and scripts/sync-cc-plugin.sh
# so the installer and the plugin generator can never disagree about which skill
# belongs to which group. Callers set SKILL_GROUPS_FILE or REPO_DIR first.

SKILL_GROUPS_FILE="${SKILL_GROUPS_FILE:-${REPO_DIR:-.}/skills/GROUPS}"

declared_groups() {
	awk '$1 == "group" && NF >= 2 { print $2 }' "$SKILL_GROUPS_FILE"
}

explicit_groups() {
	awk '$1 == "explicit" && NF >= 2 { print $2 }' "$SKILL_GROUPS_FILE"
}

group_explicit() {
	explicit_groups | grep -Fxq "$1"
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
		case "$entry" in '' | '#'* | group | explicit) continue ;; esac
		if [[ "$entry" == "$name" && -n "$group" ]]; then
			printf '%s' "$group"
			return 0
		fi
	done <"$SKILL_GROUPS_FILE"
	printf 'core'
}

assigned_groups() {
	awk '$1 != "group" && $1 != "explicit" && $1 !~ /^#/ && NF >= 2 { print $2 }' "$SKILL_GROUPS_FILE" | sort -u
}

# A group may gate instructions alone. Skills are the whole payload of a
# generated group plugin, so one with none would publish an empty plugin.
# Answered from the tree, not the membership records, so a record naming a
# skill that does not exist cannot claim a payload.
group_has_skills() {
	local skills_dir skill
	[[ "$1" == core ]] && return 0
	skills_dir="$(dirname "$SKILL_GROUPS_FILE")"
	for skill in "$skills_dir"/*/; do
		[[ -d "$skill" ]] || continue
		if [[ "$(skill_group "$(basename "$skill")")" == "$1" ]]; then
			return 0
		fi
	done
	return 1
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
	local group orphan duplicate
	# A membership line that lost its group name would otherwise fall through to
	# core, shipping that skill to everyone by default.
	orphan="$(awk '$1 != "group" && $1 != "explicit" && $1 !~ /^#/ && NF == 1 { print $1 }' "$SKILL_GROUPS_FILE")"
	if [[ -n "$orphan" ]]; then
		echo "ERROR: $SKILL_GROUPS_FILE has membership lines without a group: $orphan" >&2
		return 1
	fi
	# Two memberships for one skill resolve first-match here and last-match in
	# the TypeScript reader, so the two would ship different sets.
	duplicate="$(awk '$1 != "group" && $1 != "explicit" && $1 !~ /^#/ && NF >= 2 { print $1 }' \
		"$SKILL_GROUPS_FILE" | sort | uniq -d)"
	if [[ -n "$duplicate" ]]; then
		echo "ERROR: $SKILL_GROUPS_FILE names more than one group for: $duplicate" >&2
		return 1
	fi
	# An explicit marker for an undeclared group is a manifest typo that would
	# otherwise gate nothing.
	for group in $(explicit_groups); do
		if ! group_declared "$group"; then
			echo "ERROR: $SKILL_GROUPS_FILE marks undeclared group '$group' explicit." >&2
			return 1
		fi
	done
	for group in $(assigned_groups); do
		if ! group_declared "$group"; then
			echo "ERROR: $SKILL_GROUPS_FILE assigns skills to undeclared group '$group'." >&2
			return 1
		fi
	done
	return 0
}
