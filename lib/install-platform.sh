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
		# Callers without group selection (tests sourcing this lib directly)
		# get the default: review excluded.
		case "$name" in
		review-gate | review-profile)
			if ! declare -F group_selected >/dev/null || ! group_selected review; then
				if [[ -e "$tools_dir/$name" || -L "$tools_dir/$name" ]]; then
					rm -f "$tools_dir/$name"
					echo "[tools] Removing (review group not selected): $name"
				else
					echo "[tools] Skipping (review group — add --with review): $name"
				fi
				continue
			fi
			;;
		esac
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
				if declare -F group_selected >/dev/null && group_selected review; then
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

		if [[ -f "$rules_dir/$name" ]]; then
			echo "[codex] Updating policy: $name"
		else
			echo "[codex] Installing policy: $name"
		fi

		cp "$rules_file" "$rules_dir/$name"
	done
}
