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
5. **Do not hand findings to the user to approve.** They are not a queue for
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
