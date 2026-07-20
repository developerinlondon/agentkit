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

   Three shapes this takes, all observed in a single day: a change description
   asserted a compatibility requirement over "every" existing client, and one
   grep showed the population was empty; a comment cited probe evidence for a
   branch, but the probe predated the change that would exercise it, so it
   evidenced a different case; a table added to stop drift carried a row
   contradicted by code in the same file.

   Report any claim that outruns its evidence, **even when the code is
   correct**. Wrong prose is not cosmetic — it teaches the next reader a wrong
   model, and the next change is made against that model.
6. **Log process gaps to the reflection log.** Immediately after writing the
   verdict, append one JSON object per gap to `~/.agentkit/reflections.jsonl`
   (machine-global, append-only — these are lessons about how the agent works,
   not about a codebase):

   **Read the log before appending.** `grep '"class":"<class>"'` for the same
   class; if one matches, set `repeat_of` to that entry's `id`. Skip this and
   `repeat_of` is null forever — and a repeat is the only thing separating a
   mistake from a pattern, which is precisely what the batching step keys on.

   ```text
   {"id":"2026-07-20T14:32:07Z","harness":"claude","repo":"<repo>","class":"unverified-claim","gap":"asserted a compatibility requirement over all clients without grepping for one","finding":"HIGH: claim contradicted by git grep","repeat_of":null}
   ```

   One object per line, no pretty-printing — many sessions append here and the
   file must stay line-addressable. `id` is an ISO-8601 timestamp to the second:
   unique across concurrent sessions and stable to reference, which a date is
   not. `repeat_of` carries an earlier entry's `id`, else `null`. `harness` is
   one of `claude`, `codex`, `opencode`, `other` — not bookkeeping, it is what
   shows whether different harnesses fail in different ways.

   `class` is a fixed vocabulary, so repeats are greppable rather than a
   judgement about whether two sentences mean the same thing: `unverified-claim`,
   `untested-value`, `unobserved-external-behaviour`, `duplicated-authority`,
   `stale-doc`, `other`. Free prose in `gap` cannot be matched reliably — a
   tired reviewer greps one wording and misses its twin, which is the failure
   this step exists to prevent. Add to the vocabulary deliberately, in an MR;
   do not invent a class inline. Write entries compactly, with no spaces after
   the colons, so the grep above matches.

   **When a gap fits two classes, take the EARLIEST link in the chain** — the
   step that, had it happened, would have stopped the rest. A rule table
   contradicted by its own file is `unverified-claim` (nobody checked it against
   the code), not `stale-doc` (what it became) or `duplicated-authority` (what it
   was about). Consistency matters more than picking the best label, because the
   entire value is that repeats collide.

   **`other` is a debt, not an escape hatch.** It exists so a novel gap is
   recorded rather than dropped — but name the would-be class in `gap`, and the
   second time an `other` recurs, propose the new class in an MR. An `other`
   that recurs unnamed has quietly restored free prose.

   **Entry-worthy is one binary test: would the fix be a line in the SOP, or a
   line in the code?** SOP ⇒ entry (the author asserted something without
   checking; the process had no step that would have caught it). Code ⇒
   ordinary bug, no entry. A bug caught by review is the system working; a
   process gap is the system missing.

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

Before building on another system's behaviour, OBSERVE it: run a probe, capture
a real payload, or quote the doc with its URL. Record the payload **verbatim,
next to the code that depends on it**, marked observed vs inferred (see
"Observed vs inferred" in product-review).

Assumptions about wire protocols, event names, error shapes and field
nullability are the ones that bite — and tests written from an assumption
cannot catch it, they encode it.

Illustration: a feature wired to an event name the vendor's API does not emit on
that transport shipped green, because the tests synthesised the imaginary event.
A five-minute probe found it, and each further probe in that session also
contradicted an assumption.

## Mutation-Check Load-Bearing Values

Take the **one or two values this change is actually about** — not every value
the feature touches. A re-run per value is the one rule here that can eat an
afternoon on a slow suite. Replace each with a constant and re-run.

- **A green suite means that value is not covered.**
- **If nothing can observe the value — the test double cannot report anything
  else — building that seam is part of this change, not a follow-up.** No test
  can exist until it does. This is the case that motivated the rule.
- **Confirm the mutation applied and compiled** before believing any result. An
  invalid mutation reads exactly like "covered".
- **Judge by the run's output markers, never its exit status** — see
  **resource-safe-execution**. Runners report success on builds that never ran.

Illustration: the one number a feature turned on passed all 158 of its tests
when replaced with a constant zero — the double could not report a non-zero, so
no test could observe it.

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
stale note is worse than none, because it is trusted. A note recording one cause
for a class of build failure kept sending its own author back to that cause for
hours after the real one — a different, unrelated misconfiguration — had been
identified.

### Batching the reflection log

Reviewers append process gaps to `~/.agentkit/reflections.jsonl` (see gate step
6). As the **author**, read it and batch entries into a proposed change to these
disciplines when there is real signal: a non-null `repeat_of`, or several entries
pointing the same way. One entry is an anecdote.

**Never auto-apply.** An SOP change goes through review like any other change —
that is the whole reason the log is a queue and not a config file.
