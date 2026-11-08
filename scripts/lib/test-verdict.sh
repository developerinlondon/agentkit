# shellcheck shell=bash disable=SC2034  # sourced: TEST_VERDICT_* are the caller's.
# Judge a bun test run by its printed pass/fail counts, never by its exit code.
# A runner that dies before executing anything — a lock it cannot take, a
# scrubbed environment variable — prints no marker at all, and a caller reading
# $? sees success. Absence of a marker is its own verdict here.
#
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test-verdict.sh"

TEST_VERDICT_PASS=0
TEST_VERDICT_FAIL=0
TEST_VERDICT_ERRORS=0

# Returns 0 green, 1 red, 3 nothing ran.
test_verdict() {
	local output="$1"
	local pass fail errors

	pass="$(grep -Eo '^[[:space:]]*[0-9]+ pass' "$output" | tail -1 | grep -Eo '[0-9]+' || true)"
	fail="$(grep -Eo '^[[:space:]]*[0-9]+ fail' "$output" | tail -1 | grep -Eo '[0-9]+' || true)"
	# A file that throws while bun collects it drops its tests from both counts
	# and is reported only on the summary line after the fail count; bun exits
	# non-zero on it. Any other "N errors" line is something a test printed.
	errors="$(awk '/^[[:space:]]*[0-9]+ fail/ { after = NR; n = "" } NR == after + 1 && /^[[:space:]]*[0-9]+ errors?[[:space:]]*$/ { n = $1 } END { print n }' "$output")"

	if [[ -z "$pass" || -z "$fail" ]]; then
		TEST_VERDICT_PASS=0
		TEST_VERDICT_FAIL=0
		TEST_VERDICT_ERRORS=0
		return 3
	fi

	TEST_VERDICT_PASS="$pass"
	TEST_VERDICT_FAIL="$fail"
	TEST_VERDICT_ERRORS="${errors:-0}"
	if [[ "$fail" -gt 0 || "$TEST_VERDICT_ERRORS" -gt 0 ]]; then
		return 1
	fi
	return 0
}
