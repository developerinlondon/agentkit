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

   Three claim defects landed in one day: an MR asserting "every currently
   paired device sends the old frame shape" (the frame did not exist on the
   other repo's main — the population was empty); a comment citing probe
   evidence for a correlation branch (the probe predated the change that would
   exercise it, so it evidenced a different case); an authority table added to
   prevent drift, carrying a row contradicted by code in the same file.

   Report any claim that outruns its evidence, **even when the code is
   correct**. Wrong prose is not cosmetic — it teaches the next reader a wrong
   model, and the next change is made against that model.
6. **Log process gaps to the reflection log.** Immediately after writing the
   verdict, append one JSON object per gap to `~/.agentkit/reflections.jsonl`
   (machine-global, append-only — these are lessons about how the agent works,
   not about a codebase):

   ```json
   {
     "date": "2026-07-20",
     "repo": "neutron",
     "gap": "asserted every paired device sends the old frame without grepping the other repo",
     "finding": "MR !13 HIGH: claim contradicted by git grep",
     "repeat": false
   }
   ```

   **Keep the filter narrow or nobody will read it.** Entry-worthy: the author
   asserted something without checking; no test could have caught this; this is
   the second time this class appeared (set `repeat`). NOT entry-worthy: an
   ordinary logic bug found in review. A bug caught by review is the system
   working; a process gap is the system missing.

   The signal must come from the **reviewer**, not the author — an author
   under-reports their own errors by construction.
7. **Do not hand findings to the user to approve.** They are not a queue for
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

The most expensive defect of one session: interruption was wired to
`response.cancelled`, an event the OpenAI Realtime API does not emit on that
transport. It shipped green because the tests synthesised the imaginary event. A
five-minute live probe found it — and every subsequent probe also contradicted
an assumption (truncation after `response.done` works; `event_id` arrives
`null`, not absent).

Before you build on another system's behaviour, OBSERVE it: run a probe, capture
a real payload, or quote the doc with its URL. Assumptions about wire protocols,
event names, error shapes and field nullability are the ones that bite, and
tests you write from the assumption cannot catch it — they encode it.

Record the observed payload **verbatim, next to the code that depends on it**,
and mark it observed vs inferred (see "Observed vs inferred" in product-review).

## Mutation-Check Load-Bearing Values

`played_ms` — the number the entire feature turned on — passed all 158 tests
when replaced with a constant zero. The test double could not report a non-zero
value, so no test could observe it.

For each value the feature's correctness depends on, replace it with a constant
and re-run. **A green suite means that value is not covered.**

Verify the mutation actually APPLIED and COMPILED before believing the result —
an invalid mutation reads exactly like "covered". Note that `bounded-run`
returns exit 0 even on a hard build failure, and the harness completion notice
repeats that exit code, so judge by output markers (`test result:`, `N pass`)
and treat a missing summary line as failure.

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

### The retro trigger is a disproof, not a timer

When a reviewer disproves something you asserted, **that** is the moment to
write or correct a memory — not at session end, not on a schedule. The
correction is cheapest while the evidence is still in front of you.

Counterweight: memories and reflections rot. On 2026-07-20 a memory the author
had written themselves sent them chasing a poisoned-cargo-target-dir theory for
hours when the real cause was a toolchain mismatch (`RUSTUP_TOOLCHAIN` pinned to
an older version than the cargo binary). Correcting and pruning matters as much
as appending — a confident stale note is worse than none, because it is trusted.

### Batching the reflection log

Reviewers append process gaps to `~/.agentkit/reflections.jsonl` (see gate step
6). As the **author**, read it and batch entries into an agentkit MR when there
is real signal: a `repeat`, or several entries pointing the same way. One entry
is an anecdote.

**Never auto-apply.** An SOP change goes through review like any other change —
that is the whole reason the log is a queue and not a config file.
