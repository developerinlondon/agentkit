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
	local counts pass fail errors

	# A runner that drives several files prints one summary per file, and a
	# clean later summary must not hide an earlier failure, so every summary is
	# summed. A summary is a fail count with the nearest pass count before it,
	# and counts only once bun's "Ran N tests across" line closes it: pass and
	# fail lines a test prints come before bun's own. A file that throws while
	# bun collects it drops its tests from both counts and shows only as
	# "N errors" on the line after the fail count.
	counts="$(awk '
		/^[[:space:]]*[0-9]+ pass/ { last_pass = $1; have_pass = 1 }
		/^[[:space:]]*[0-9]+ fail/ && have_pass { bp = last_pass; bf = $1; be = 0; open = 1; have_pass = 0; after = NR }
		after && NR == after + 1 && /^[[:space:]]*[0-9]+ errors?[[:space:]]*$/ { be = $1 }
		/^Ran [0-9]+ tests? across/ && open { p += bp; f += bf; e += be; blocks++; open = 0 }
		END { if (blocks) print p + 0, f + 0, e + 0 }
	' "$output")"
	read -r pass fail errors <<<"$counts"

	if [[ -z "$pass" || -z "$fail" ]]; then
		TEST_VERDICT_PASS=0
		TEST_VERDICT_FAIL=0
		TEST_VERDICT_ERRORS=0
		return 3
	fi

	TEST_VERDICT_PASS="$pass"
	TEST_VERDICT_FAIL="$fail"
	TEST_VERDICT_ERRORS="$errors"
	if [[ "$fail" -gt 0 || "$errors" -gt 0 ]]; then
		return 1
	fi
	return 0
}
