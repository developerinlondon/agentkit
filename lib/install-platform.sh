#!/usr/bin/env bash

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

validate_platform() {
	case "$1" in
	linux | darwin | unknown) return 0 ;;
	*)
		echo "ERROR: invalid AGENTKIT_PLATFORM '$1' (expected linux, darwin, or unknown)." >&2
		return 1
		;;
	esac
}

# Managed artifacts may opt into specific hosts with a directive in their
# first 15 lines: `agentkit:platform linux` or `agentkit:platforms linux darwin`.
# No directive means portable. This parser is shared by tools and Codex rules
# so platform support is metadata, not installer-specific filename knowledge.
artifact_supports_platform() {
	local file="$1"
	local platform="$2"
	local directive supported
	directive="$(head -n 15 "$file" | grep -m1 -E 'agentkit:platforms?[[:space:]]+' || true)"
	[[ -n "$directive" ]] || return 0

	directive="${directive#*agentkit:platform}"
	directive="${directive#s}"
	directive="${directive%%#*}"
	directive="${directive//$'\r'/}"
	for supported in $directive; do
		[[ "$supported" == "$platform" ]] && return 0
	done
	return 1
}

install_tools() {
	local tools_dir="$1"
	mkdir -p "$tools_dir"

	for tool_file in "$REPO_DIR"/tools/*; do
		[[ -f "$tool_file" ]] || continue
		local name
		name="$(basename "$tool_file")"
		# Callers without kit selection (tests sourcing this lib directly)
		# get the default: review excluded.
		case "$name" in
		review-gate | review-profile)
			if ! declare -F kit_selected >/dev/null || ! kit_selected adversarial-review; then
				if [[ -e "$tools_dir/$name" || -L "$tools_dir/$name" ]]; then
					rm -f "$tools_dir/$name"
					echo "[tools] Removing (adversarial-review kit not selected): $name"
				else
					echo "[tools] Skipping (adversarial-review kit — add --with adversarial-review): $name"
				fi
				continue
			fi
			;;
		esac
		# shellcheck disable=SC2153 # PLATFORM comes from the sourcing installer, not the local `platform`.
		if ! artifact_supports_platform "$tool_file" "$PLATFORM"; then
			if [[ -e "$tools_dir/$name" || -L "$tools_dir/$name" ]]; then
				rm -f "$tools_dir/$name"
				echo "[tools] Removing unsupported: $name ($PLATFORM)"
			else
				echo "[tools] Skipping unsupported: $name ($PLATFORM)"
			fi
			continue
		fi

		if [[ -f "$tools_dir/$name" ]]; then
			echo "[tools] Updating: $name"
		else
			echo "[tools] Installing: $name"
		fi

		cp "$tool_file" "$tools_dir/$name"
		chmod +x "$tools_dir/$name"
	done

	# Compat alias: bounded-run was previously named agentkit-run.
	if [[ -f "$tools_dir/bounded-run" ]]; then
		ln -sf bounded-run "$tools_dir/agentkit-run"
	elif [[ -e "$tools_dir/agentkit-run" || -L "$tools_dir/agentkit-run" ]]; then
		rm -f "$tools_dir/agentkit-run"
	fi
}

reconcile_tool_links() {
	local tools_dir="$1"
	local tool_file name
	for tool_file in "$REPO_DIR"/tools/*; do
		[[ -f "$tool_file" ]] || continue
		name="$(basename "$tool_file")"
		if artifact_supports_platform "$tool_file" "$PLATFORM"; then
			case "$name" in
			review-gate | review-profile)
				if declare -F kit_selected >/dev/null && kit_selected adversarial-review; then
					continue
				fi
				;;
			*) continue ;;
			esac
		fi
		[[ -e "$tools_dir/$name" || -L "$tools_dir/$name" ]] && rm -f "$tools_dir/$name"
	done
	if [[ ! -f "$tools_dir/bounded-run" && ( -e "$tools_dir/agentkit-run" || -L "$tools_dir/agentkit-run" ) ]]; then
		rm -f "$tools_dir/agentkit-run"
	fi
}

agentkit_config_file() {
	printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/agentkit/config.yaml"
}

# One scalar key from a top-level section of the user config. Quoted values
# are legal YAML, so quotes are stripped before the caller compares.
agentkit_config_value() {
	local section="$1" key="$2" file
	file="$(agentkit_config_file)"
	[[ -f "$file" ]] || return 0
	awk -v section="$section" -v key="$key" '
		/^[^[:space:]#]/ {
			in_section = (substr($0, 1, length(section) + 1) == section ":")
			next
		}
		in_section {
			line = $0
			sub(/^[[:space:]]+/, "", line)
			if (substr(line, 1, length(key) + 1) != key ":") next
			sub(/^[^:]*:[[:space:]]*/, "", line)
			sub(/[[:space:]#].*$/, "", line)
			gsub(/["'\'']/, "", line)
			if (line == "") next
			print tolower(line)
			exit
		}
	' "$file"
}

agentkit_unit_enabled() {
	[[ "$(agentkit_config_value "$1" enabled)" == true ]]
}

# The `bounded` classes, one per line, after a `@list` marker emitted whenever
# the key is present: absent key = every class, present-but-empty = none —
# the same distinction the runtime hook and plugin make.
agentkit_resource_classes() {
	local file
	file="$(agentkit_config_file)"
	[[ -f "$file" ]] || return 0
	awk '
		/^[^[:space:]#]/ {
			in_section = ($0 ~ /^resource-police:/)
			in_list = 0
			next
		}
		!in_section { next }
		{
			line = $0
			sub(/^[[:space:]]+/, "", line)
		}
		line ~ /^bounded:[[:space:]]*\[/ {
			print "@list"
			sub(/^bounded:[[:space:]]*\[/, "", line)
			sub(/\].*$/, "", line)
			n = split(line, parts, /,/)
			for (i = 1; i <= n; i++) {
				gsub(/[[:space:]"'\'']/, "", parts[i])
				if (parts[i] != "") print tolower(parts[i])
			}
			in_list = 0
			next
		}
		line ~ /^bounded:/ { print "@list"; in_list = 1; next }
		in_list && line ~ /^-/ {
			sub(/^-[[:space:]]*/, "", line)
			sub(/[[:space:]#].*$/, "", line)
			gsub(/["'\'']/, "", line)
			if (line != "") print tolower(line)
			next
		}
		line ~ /^[[:alnum:]_-]+:/ { in_list = 0 }
	' "$file"
}

# Enforcement policies are opt-in: absent or disabled config means the policy
# is not installed and an installed copy is removed. Only these names are
# managed conditionally; everything else in policies/codex/ installs as before,
# and user-owned rules files are never touched.
codex_policy_selected() {
	case "$1" in
	delegation-police.rules) agentkit_unit_enabled delegation-police ;;
	resource-police.rules) agentkit_unit_enabled resource-police ;;
	pkg-police.rules) [[ "$(agentkit_config_value pkg-police manager)" == bun ]] ;;
	*) return 0 ;;
	esac
}

codex_policy_requirement() {
	case "$1" in
	delegation-police.rules) printf 'delegation-police.enabled: true' ;;
	resource-police.rules) printf 'resource-police.enabled: true' ;;
	pkg-police.rules) printf 'pkg-police.manager: bun' ;;
	esac
}

# Copies resource-police.rules keeping only the rule blocks whose
# `# agentkit:resource-class <class>` marker names an enabled class.
# Unmarked blocks always install. A dropped block takes its own leading
# comment lines with it so the installed file reads clean.
install_codex_resource_policy() {
	local rules_file="$1" dest="$2"
	local classes
	classes="$(agentkit_resource_classes | tr '\n' ' ')"
	if [[ "$classes" != "@list"* ]]; then
		cp "$rules_file" "$dest"
		return
	fi
	classes="${classes#@list }"
	classes="${classes#@list}"
	awk -v classes=" $classes " '
		function flush() {
			if (have) printf "%s", pending
			pending = ""
			have = 0
		}
		/^# agentkit:resource-class / {
			drop = (index(classes, " " $NF " ") == 0)
			if (drop) {
				pending = ""
				have = 0
			} else {
				flush()
			}
			next
		}
		drop {
			if ($0 ~ /^\)/) drop = 0
			next
		}
		/^($|#)/ {
			pending = pending $0 "\n"
			have = 1
			next
		}
		{
			flush()
			print
		}
		END { flush() }
	' "$rules_file" >"$dest"
}

install_codex_policies() {
	local rules_dir="$1"
	mkdir -p "$rules_dir"

	for rules_file in "$REPO_DIR"/policies/codex/*.rules; do
		[[ -f "$rules_file" ]] || continue
		local name
		name="$(basename "$rules_file")"
		if ! artifact_supports_platform "$rules_file" "$PLATFORM"; then
			if [[ -e "$rules_dir/$name" || -L "$rules_dir/$name" ]]; then
				rm -f "$rules_dir/$name"
				echo "[codex] Removing unsupported policy: $name ($PLATFORM)"
			else
				echo "[codex] Skipping unsupported policy: $name ($PLATFORM)"
			fi
			continue
		fi

		if ! codex_policy_selected "$name"; then
			if [[ -e "$rules_dir/$name" || -L "$rules_dir/$name" ]]; then
				rm -f "$rules_dir/$name"
				echo "[codex] Removing policy (off by default; enable with $(codex_policy_requirement "$name") in config.yaml): $name"
			else
				echo "[codex] Skipping policy (off by default; enable with $(codex_policy_requirement "$name") in config.yaml): $name"
			fi
			continue
		fi

		if [[ -f "$rules_dir/$name" ]]; then
			echo "[codex] Updating policy: $name"
		else
			echo "[codex] Installing policy: $name"
		fi

		if [[ "$name" == resource-police.rules ]]; then
			install_codex_resource_policy "$rules_file" "$rules_dir/$name"
		else
			cp "$rules_file" "$rules_dir/$name"
		fi
	done
}
