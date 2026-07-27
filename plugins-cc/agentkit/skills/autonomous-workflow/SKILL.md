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

Review is a gate, not a parallel task and not advice. `review-police.sh`
blocks the CLI, REST and MCP merge paths without a passing record for the exact
commit being merged.

Be honest about its limits: the record lives in the repo and you can write it,
so the hook cannot _prevent_ a determined bypass — it makes the honest path
correct, makes a missing or stale review impossible to merge past by accident,
and logs every pass and override to `~/.agentkit/review-audit.log`. Only
forge-side required approvals actually prevent a merge. Never describe this
gate as something it is not.

1. **Review completes before the merge starts.** Never dispatch a reviewer and
   merge while it works — a verdict that lands after the code is on main
   protects nobody.
2. **The reviewer writes its verdict** to `.agentkit/reviews/<branch-slug>.json`
   with `head_sha`, `verdict`, and `findings[{severity, summary, resolved}]`.
   A review of an older commit is not a review of what you are merging.

   That file is a machine-local GATE TOKEN, not an archive: it is gitignored,
   it is only ever read by the hook on one machine, and after the merge it is
   an orphan nobody can see. So **also post the verdict and findings as a
   comment on the MR/PR** (`glab mr note` / `gh pr comment`). That copy is the
   durable one — visible to whoever picks the work up, timestamped, and it
   survives the merge. It must NOT be committed to the repo: a commit moves
   HEAD, which stales the record against the branch it reviews, and the gate
   would then deny its own merge.

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
   approve in writing, record their exact words in `user_consent`. Fabricating
   that is forging their approval.

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
- **Judge by the run's output markers, never its exit status** — see
  **resource-safe-execution**. Runners report success on builds that never ran.

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
