---
name: adversarial-review
description: >-
  Falsify a proposed plan or implementation with independent traces, concrete failing
  inputs, claims verification, scope re-derivation, and lifecycle analysis. Use for
  non-trivial code review, plan refutation, security or reliability changes, bug fixes,
  merge-gate evidence, and any request to adversarially review or prove a change wrong.
---

# Adversarial Review

Assume the artifact is wrong and try to prove it. Agreement is not evidence;
executed or computed ground truth is.

## Independence boundary

- Work read-only. Do not fix the artifact you grade.
- Start from primary artifacts: the raw report/error/log, repository state,
  exact commits or diff, policy, and reproducible commands.
- Do not read the maker's summary, claimed rationale, or other reviewers'
  conclusions before the independent trace. Comments embedded in code may still
  carry framing; treat them as claims to compare after tracing.
- Re-derive scope from the raw finding and system. When a pattern class matters,
  classify every row in a mechanically generated candidate set; do not invent or
  silently narrow that set.

## Workflow

1. **Trace before reading the maker narrative.** Reproduce or hand-simulate the
   documented or most likely failure against the actual code. Show intermediate
   state, inputs, identities, rates, or values.
2. Generate fresh failure hypotheses. Attack unstated assumptions: credentials,
   ownership, bounds, concurrency, stale state, retries, teardown, revocation,
   navigation, and session replacement.
3. Trace any durable artifact through its lifetime: timers, listeners, caches,
   credentials, loops, locks, and persistent UI.
4. Audit every behavioral or quantitative claim. Mark it `verified` with a
   computation, trace, probe, or source reference; otherwise mark it
   `unverified`. An analogy requires an explicit point-of-difference analysis.
5. Execute the smallest deterministic checks that can kill each hypothesis.
   Use the project's resource-safe execution boundary for heavy checks.
6. Compare the independent trace with the maker's narrative only after the trace
   exists. Record every disagreement.

## Findings standard

A finding exists only with a concrete failing input or a replayable trace. Give
at most the three highest-severity findings per pass. Each finding contains:

- lane: `diff` or `product`;
- severity: `BLOCKER`, `HIGH`, `MEDIUM`, or `LOW`;
- concise summary;
- concrete scenario and intermediate state;
- source locations or commands needed to replay it;
- remediation condition, without implementing the remediation.

An empty result is valid. Report the falsifications attempted and the evidence
for why each held; do not manufacture findings to appear useful.

## Required output

Return:

1. `verdict`: `pass` or `blocked`;
2. attempted falsifications and their observed results;
3. findings in the strict shape above;
4. a claims list with `verified` or `unverified` status and evidence/reason;
5. explicit dispositions for failure trace, analogy differences, pattern sweep,
   new assumptions, and artifact lifetime;
6. deterministic checks with exact command, exit status, and output summary;
7. remaining uncertainty and what would resolve it.

Post a redacted evidence summary to the PR/MR when the workflow requires durable
evidence. Redact secrets, tokens, and personal data before posting. A local
record or evidence link does not authenticate reviewer identity, prove commands
ran, or prove the referenced claims true; forge protections remain the trust
boundary.

When orchestrating this role, use
[references/reviewer-dispatch.md](references/reviewer-dispatch.md) verbatim and
fill only its artifact slots.
