#!/usr/bin/env bash
# Manual probe harness: feeds each tab-separated "EXPECT<TAB>command" line from
# probe-cases.txt to the hook and reports mismatches. Cases live in a data file
# so this script never contains a merge-shaped command itself.
set -uo pipefail
cd "$(dirname "$0")/.."
HOOK=hooks/claude/review-police.sh
fail=0
while IFS=$'\t' read -r want cmd; do
	[[ -z "${want:-}" || "${want:0:1}" == "#" ]] && continue
	payload=$(cmd="$cmd" python3 -c 'import json,os;print(json.dumps({"tool_name":"Bash","tool_input":{"command":os.environ["cmd"]},"session_id":"probe"}))')
	if printf '%s' "$payload" | bash "$HOOK" 2>/dev/null | grep -q deny; then got=DENY; else got=ALLOW; fi
	if [[ "$got" == "$want" ]]; then
		printf 'ok   %-5s %s\n' "$got" "$cmd"
	else
		printf 'FAIL want=%-5s got=%-5s %s\n' "$want" "$got" "$cmd"
		fail=1
	fi
done <tests/probe-cases.txt
exit $fail
