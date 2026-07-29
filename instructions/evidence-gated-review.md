<!-- agentkit:evidence-gated-review:start -->

# Evidence-Gated Review

For non-trivial work, the maker never grades its own artifact. Resolve review effort with
`review-profile`, then use the required `adversarial-review` lane from a fresh context, feed it
primary artifacts, and require a concrete failing input or replayable trace for every finding.
The balanced default uses one reviewer; specialist and product lanes are risk-triggered. Finish
deterministic preflight before freezing the source head, and reuse passed CI evidence bound to that
exact SHA unless the profile requires a rerun.

When a forge target contains `.agentkit/review-policy.json`, load policy from the exact target
commit, never the proposed source checkout. Bind the local v2 evidence index to the forge
repository and change, source/target SHAs, and policy digest. Missing or malformed required
evidence fails closed; critical work cannot use a local consent claim. The record is an
agent-writable consistency gate, not proof of reviewer identity or evidence truth — protected
forge checks and approvals remain the trust boundary.

Review profiles control orchestration, not authority. Target-owned policy is authoritative and can
require checks, product coverage, analyses, or evidence omitted by a local profile.

Findings discipline: report findings at or above the profile's severity floor (default: LOW —
INFO and NIT observations are dropped, not logged). The gate blocks only on the severities the
target policy names as blocking (default: BLOCKER and HIGH).

<!-- agentkit:evidence-gated-review:end -->
