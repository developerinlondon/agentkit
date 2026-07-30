#!/usr/bin/env bash
# Readers for skills/KITS, shared by install.sh and scripts/sync-cc-plugin.sh
# so the installer and the plugin generator can never disagree about which skill
# belongs to which kit. Callers set SKILL_KITS_FILE or REPO_DIR first.

SKILL_KITS_FILE="${SKILL_KITS_FILE:-${REPO_DIR:-.}/skills/KITS}"

declared_kits() {
	awk '$1 == "kit" && NF >= 2 { print $2 }' "$SKILL_KITS_FILE"
}

explicit_kits() {
	awk '$1 == "explicit" && NF >= 2 { print $2 }' "$SKILL_KITS_FILE"
}

kit_explicit() {
	explicit_kits | grep -Fxq "$1"
}

kit_description() {
	awk -v want="$1" '$1 == "kit" && $2 == want {
		$1 = ""; $2 = ""; sub(/^[ \t]+/, ""); print; exit
	}' "$SKILL_KITS_FILE"
}

kit_declared() {
	declared_kits | grep -Fxq "$1"
}

skill_kit() {
	local name="$1" entry kit
	while read -r entry kit _; do
		case "$entry" in '' | '#'* | kit | explicit) continue ;; esac
		if [[ "$entry" == "$name" && -n "$kit" ]]; then
			printf '%s' "$kit"
			return 0
		fi
	done <"$SKILL_KITS_FILE"
	printf 'core'
}

assigned_kits() {
	awk '$1 != "kit" && $1 != "explicit" && $1 !~ /^#/ && NF >= 2 { print $2 }' "$SKILL_KITS_FILE" | sort -u
}

# Answered from the tree, so a record naming a missing skill claims no payload.
# Callers act on "no" destructively (skip generation, prune plugin trees), so a
# tree with no skill dirs at all means we are pointed at the wrong place — then
# refuse to claim it is empty rather than answer "no" for every kit.
kit_has_skills() {
	local skills_dir skill found=0
	[[ "$1" == core ]] && return 0
	skills_dir="$(dirname "$SKILL_KITS_FILE")"
	for skill in "$skills_dir"/*/; do
		[[ -d "$skill" ]] || continue
		found=1
		if [[ "$(skill_kit "$(basename "$skill")")" == "$1" ]]; then
			return 0
		fi
	done
	[[ "$found" == 0 ]] && return 0
	return 1
}

# Kit names that no longer exist. Read by both the installer (to retire the
# artifacts an older install left behind) and by whatever lifts these readers,
# so the vocabulary has one home rather than one per caller.
RETIRED_KIT_NAMES="review strict-review"

# A retired name that comes back as a declared kit is not retired, whatever the
# list says — the manifest is the authority, and callers act on this destructively.
kit_name_retired() {
	kit_declared "$1" && return 1
	case " $RETIRED_KIT_NAMES " in
	*" $1 "*) return 0 ;;
	esac
	return 1
}

# One plugin per kit, named from the manifest: core ships as `agentkit`, every
# other kit as `agentkit-<kit>`.
kit_plugin_id() {
	if [[ "$1" == core ]]; then
		printf 'agentkit'
	else
		printf 'agentkit-%s' "$1"
	fi
}

# A membership naming an undeclared kit would make that skill uninstallable by
# any flag — the one manifest typo no other check can catch.
validate_skill_kits() {
	if [[ ! -f "$SKILL_KITS_FILE" ]]; then
		echo "ERROR: missing $SKILL_KITS_FILE — cannot resolve skill kits." >&2
		return 1
	fi
	local kit orphan duplicate
	# A membership line that lost its kit name would otherwise fall through to
	# core, shipping that skill to everyone by default.
	orphan="$(awk '$1 != "kit" && $1 != "explicit" && $1 !~ /^#/ && NF == 1 { print $1 }' "$SKILL_KITS_FILE")"
	if [[ -n "$orphan" ]]; then
		echo "ERROR: $SKILL_KITS_FILE has membership lines without a kit: $orphan" >&2
		return 1
	fi
	# Two memberships for one skill resolve first-match here and last-match in
	# the TypeScript reader, so the two would ship different sets.
	duplicate="$(awk '$1 != "kit" && $1 != "explicit" && $1 !~ /^#/ && NF >= 2 { print $1 }' \
		"$SKILL_KITS_FILE" | sort | uniq -d)"
	if [[ -n "$duplicate" ]]; then
		echo "ERROR: $SKILL_KITS_FILE names more than one kit for: $duplicate" >&2
		return 1
	fi
	# An explicit marker for an undeclared kit is a manifest typo that would
	# otherwise gate nothing.
	for kit in $(explicit_kits); do
		if ! kit_declared "$kit"; then
			echo "ERROR: $SKILL_KITS_FILE marks undeclared kit '$kit' explicit." >&2
			return 1
		fi
	done
	for kit in $(assigned_kits); do
		if ! kit_declared "$kit"; then
			echo "ERROR: $SKILL_KITS_FILE assigns skills to undeclared kit '$kit'." >&2
			return 1
		fi
	done
	return 0
}
