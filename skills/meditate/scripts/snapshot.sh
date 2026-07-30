#!/usr/bin/env bash
# Concatenate a directory's .md files into one snapshot, each delimited by an
# `=== path ===` header. Usage: snapshot.sh <dir> <output-file>
set -euo pipefail

dir="${1:?usage: snapshot.sh <dir> <output-file>}"
output="${2:?usage: snapshot.sh <dir> <output-file>}"

: >"$output"

find "$dir" -name '*.md' -type f -not -path '*/node_modules/*' | sort \
	| while IFS= read -r f; do
		{
			printf '=== %s ===\n' "$f"
			cat "$f"
			printf '\n\n'
		} >>"$output"
	done

echo "$output"
