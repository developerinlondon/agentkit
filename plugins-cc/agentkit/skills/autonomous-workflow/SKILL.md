---
name: autonomous-workflow
description: >-
  Proposal-first development workflow with commit hygiene and decision authority rules.
  Enforces: propose before modifying, atomic commits, no force flags, warnings-as-errors.
  Use for any project where AI agents are primary developers and need guardrails.
---

# Autonomous Workflow

## Proposal-First (CRITICAL)

NEVER create or modify files without explicit approval. Always:

1. PROPOSE the change (what, why, which files)
2. WAIT for approval
3. IMPLEMENT only after approval

Exceptions: bug fixes in already-approved work, read-only research, formatting.

## Decision Authority (for approved work)

- Fix bugs, warnings, missing error handling, broken imports: proceed without asking
- Add missing tests, fix linting issues, update outdated deps: proceed without asking
- Change architecture, add new infrastructure, switch libraries: ASK first
- Delete or significantly restructure existing code: ASK first

## After Every Change

- Run the relevant test suite
- Run the linter/type checker
- Fix ALL warnings, not just errors
- Run the project's formatter on changed files

## Unused Variables

- NEVER prefix unused variables with underscore (_var) to silence linters
- Either USE the variable or REMOVE it entirely
- If a function parameter is required by an interface but unused, restructure to avoid it
- This applies to all languages: TypeScript, Rust, Python

## Review Gates The Merge

Review is a gate, not a parallel task and not advice. `review-police.sh` allows
one standalone `gh pr merge` or `glab mr merge` only with a passing record for
the exact source head selected by the forge. It refuses direct REST/GraphQL/MCP
and compound or wrapped merges because they cannot be bound safely.

Be honest about its limits: the record lives in the repo and you can write it,
so the hook cannot _prevent_ a determined bypass — it makes the honest path
correct, makes a missing or stale review impossible to merge past by accident,
and logs every pass and override to `~/.agentkit/review-audit.log`. Only
forge-side required approvals actually prevent a merge. Never describe this
gate as something it is not.

1. **Review completes before the merge starts.** Never dispatch a reviewer and
   merge while it works — a verdict that lands after the code is on main
   protects nobody.
   Run the approved merge as its own literal forge CLI command. Do not combine
   it with a push, another merge, command substitution, or any other shell
   action: PreToolUse sees the compound call only once, before any part runs.
2. **The reviewer writes its evidence index** to
   `.agentkit/reviews/<branch-slug>.json`. When the exact target commit contains
   `.agentkit/review-policy.json`, this is a strict v2 record bound to forge,
   canonical repository URL and immutable ID, change ID, source/target branches
   and SHAs, and the target-policy blob. A review of an older source or target
   context is not a review of what you are merging. Only policy absent from the
   exact target commit permits the legacy `head_sha` v1 shape.

   That file is a machine-local GATE TOKEN and evidence index, not an archive:
   it is gitignored, read by one local hook, and orphaned after merge. So **also
   post a redacted evidence packet as a comment on the MR/PR** (`glab mr note`
   / `gh pr comment`) and put its reference in `evidence_ref`. Include claims,
   checks, analyses, attempted falsifications, findings, and uncertainty. The
   durable copy is visible and timestamped, but it still does not prove reviewer
   identity or truth. Never commit the local record: a commit changes the source
   SHA and makes the record stale against itself.

   Findings that outlive the branch — accepted limits, deferred fixes — belong
   in an ISSUE, not only in a review record. If the only trace of a known
   limitation is a local JSON file, it is already lost.
3. **Any unresolved BLOCKER or HIGH blocks the merge.** Severity is the
   reviewer's call. You do not get to downgrade it, reinterpret it, or decide
   it is inert because you reason it cannot fire.
4. **The path is: fix it properly, then re-review.** Fix the root cause — not a
   workaround, not a flag that hides it, not a comment explaining why it is
   acceptable. Then re-run the reviewer against the new head and merge on a
   fresh pass.
5. **Audit the claims, not just the logic.** Grep the diff's comments, commit
   messages and MR/PR description for factual assertions — especially
   **every, always, never, all, verified, probed, cannot** — and check each
   against reality with `git grep`, a probe, or the code itself.

   Common failure shapes include a change description asserting compatibility
   with clients that do not exist, a comment citing a probe that exercised a
   different branch, or a rule table contradicted by code in the same file.

   Report any claim that outruns its evidence, **even when the code is
   correct**. Wrong prose is not cosmetic — it teaches the next reader a wrong
   model, and the next change is made against that model.
6. **Do not hand findings to the user to approve.** They are not a queue for
   work you would rather not do. Escalate only when a finding genuinely cannot
   be fixed — an upstream or platform limitation — and say why. If they then
   approve in writing, target policy may allow their exact words in
   `user_consent` for a valid blocked trivial/standard record. Critical records
   never accept local consent; use authenticated forge authority. Fabricating
   consent is forging their approval.

### Evidence-aware strict mode

Classify by blast radius, not diff size. Authentication/session, credentials,
access control, retry/reconnect, caching, rate limits, migrations, money,
irreversible operations, and review/policy enforcement are critical by default.
Tier can rise during work and never falls.

- **Plan:** use one planner only when ambiguity or decomposition is real. Resolve
  decisions before delegation and partition workers by non-overlapping concern.
  Review every plan before implementation: refinement may share history, but
  final refutation uses a fresh adversarial context.
- **Maker:** default to one capable worker. Return the diff plus a claims list;
  every behavioral or quantitative claim is computed/probed or explicitly
  `unverified`.
- **Adversary:** use the `adversarial-review` skill on every non-trivial change.
  Trace from primary artifacts before reading maker narrative. A finding counts
  only with a concrete failing input or replayable trace.
- **Product lane:** when target policy requires product coverage, run
  `product-review` separately. Diff correctness does not certify installation or
  operation.
- **Evidence:** explicitly disposition failure trace, analogy differences,
  mechanically enumerated pattern sweep, new assumptions, and artifact lifetime.
  `not_applicable` needs a reason and only satisfies policy where allowed.
- **Gate:** run deterministic checks and validate the strict record. The stored
  verdict must equal the result derived from lanes, findings, checks, claims, and
  analyses.
- **External:** critical work still requires authenticated human or
  different-family review plus protected deterministic checks. The local record
  cannot manufacture either property.

Cap fix-review at two full cycles per genuine defect class. If the same defect
still cannot be closed or guidance genuinely conflicts, stop and give the owner
the verbatim diff, findings, traces, and reviewer outputs. Critical work fails
closed when the judge/external check is unavailable.

Corollary, learned the hard way: never expose a user-facing control whose other
half is not built. Ship both halves or neither — an inert-looking toggle is
still reachable, and "it will not do anything" is a prediction, not a fact.

### Diff review is not the only lens

A diff reviewer answers "is this change correct?" — it structurally cannot see
what is not in the diff: a stale build command, a default that yields a
broken-looking install, missing packaging, a setup step that lives only in
someone's head. Those reach the user untouched no matter how many diff rounds
you run.

For anything a person installs or operates, run the **product-review** skill as
a separate pass: build it, run it, use it, from a cold start. It reads
`.agentkit/product.yaml` and refuses rather than guessing when that is absent.
When the two lenses disagree on severity, the user-facing consequence wins —
internally correct code that cannot be used is still broken.

## Observe External Behaviour Before Building On It

Before building on another system's behaviour, OBSERVE it: run a probe, capture
a real payload, or quote the doc with its URL. Preserve the relevant evidence
next to the code that depends on it, with secrets, tokens and personal data redacted,
and mark it observed vs inferred (see "Observed vs inferred" in product-review).

Assumptions about wire protocols, event names, error shapes and field
nullability are the ones that bite — and tests written from an assumption
cannot catch it, they encode it.

Tests that synthesise an assumed provider event prove only that the code handles
the invented fixture. Probe the real transport before treating that event as a
supported contract.

## Mutation-Check Load-Bearing Values

Take the **one or two values this change is actually about** — not every value
the feature touches. A re-run per value is the one rule here that can eat an
afternoon on a slow suite. Replace each with a constant and re-run.

- **A green suite means that value is not covered.**
- **Restore the original value after each run** before making any further change.
- **If nothing can observe the value — the test double cannot report anything
  else — building that seam is part of this change, not a follow-up.** No test
  can exist until it does. This is the case that motivated the rule.
- **Confirm the mutation applied and compiled** before believing any result. An
  invalid mutation reads exactly like "covered".
- **Use the run's exit status and output markers together** — see
  **resource-safe-execution**. A non-zero status fails; a zero status without the expected summary
  does not prove the intended build or test ran.

If replacing a load-bearing value with a constant leaves the suite green, the
tests do not observe that value yet.

## Commit Hygiene

- Never use --force, --no-verify, HUSKY=0 without explicit permission
- Never commit .env files, credentials, or secrets
- Atomic commits: one logical change per commit
- Never add `Co-authored-by`, `Ultraworked with`, or any AI agent attribution to commits, PRs/MRs,
  comments, or changelogs. Keep commit messages clean and focused on the change itself.

## Fresh Context for Large Work

Before starting large implementations (multi-phase plans, migrations, new stack deployments):

- Commit and push all preparatory work (plans, config updates)
- Start a fresh session / compact context to maximize available context window
- Reference the plan file for implementation details rather than relying on conversation history

## Continuous Config Improvement

Agent instructions are living documents. When you discover something that should be codified -- a new
pattern, a gotcha, a convention, a lesson learned -- PROPOSE updating the relevant config file:

1. **What to codify**: Recurring mistakes, new conventions, environment-specific gotchas, workflow
   patterns that should be standardized
2. **Always propose first**: Never silently update config files. Describe what you learned and why
   it should be codified. Wait for approval.

### Correct notes the moment they are disproved

When a reviewer disproves something you asserted, correct the stored note then —
not at session end, not on a timer. Prune as readily as you append: a confident
stale note is worse than none, because later work may trust it.
