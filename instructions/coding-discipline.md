<!-- agentkit:coding-discipline:start -->

# Coding Discipline

Default behavior for code work in this project. Bias toward caution over speed on non-trivial
changes. Use judgment on trivial tasks.

## 1. Think before coding

State assumptions explicitly. If uncertain, ask rather than guess. Present multiple
interpretations when something is ambiguous. Push back when a simpler approach exists. Stop
when confused and name what is unclear.

## 2. Simplicity first

Minimum code that solves the stated problem. Nothing speculative. No features beyond what was
asked. No abstractions for single-use code. If a senior engineer would call it overcomplicated,
simplify.

## 3. Surgical changes

Touch only what the task requires. Clean up only your own mess. Do not improve adjacent code,
comments, or formatting. Do not refactor what is not broken. Match the existing style.

## 4. Goal-driven execution

Define success criteria up front, then loop until verified. Strong success criteria let you
iterate independently — do not follow steps blindly.

## 5. Use the model for judgment, not deterministic work

Use the agent for classification, drafting, summarization, extraction. Do not route, retry, or
run deterministic transforms through the model. If code can answer, code answers.

## 6. Surface conflicts; do not average them

When two patterns in the codebase contradict, pick one — typically the more recent or more
tested. Explain why. Flag the other for cleanup. Do not blend them.

## 7. Read before you write

Before adding code, read the file's exports, immediate callers, and the shared utilities it
depends on. "Looks orthogonal" is dangerous. If you do not understand why nearby code is
structured the way it is, ask.

## 8. Tests verify intent, not just behavior

Tests must encode why the behavior matters, not only what the code does. A test that cannot
fail when the underlying business rule changes is the wrong test.

## 9. Checkpoint after every significant step

Summarize what was done, what is verified, and what is left. Do not continue from a state you
cannot describe back. If you lose track, stop and restate.

## 10. Match the codebase's conventions

Conformance beats personal taste inside the codebase. If a convention is genuinely harmful,
raise it explicitly rather than silently forking.

## 11. Fail loud

"Completed" is wrong if anything was skipped silently. "Tests pass" is wrong if any were
skipped. Default to surfacing uncertainty, not hiding it.

## Where these are mechanically enforced

These rules are behavioral; the agentkit hook portfolio enforces the adjacent concrete slices:

- Rule 2 (simplicity) — `coding-police` enforces the file (≤1000 lines), function
  (≤100 lines), duplication (≥6 lines), and per-file export caps.
- Rule 7 (read before write) — Claude Code natively errors when you Edit a file without a
  prior Read of that same file. The broader "read exports and callers first" is on the agent.
- Rule 10 (conventions) — `format-police` runs dprint on every write/edit; `comment-police`
  enforces comment discipline.
- Rule 11 (fail loud) — `git-police` blocks `--no-verify`, AI-attribution trailers, force
  push, and direct commits to protected branches.

Everything else is on the agent to honor.

## Branch Hygiene

After a merge request / PR merges, immediately return to the repo's default branch, pull, and
delete the local feature branch — don't let branches accumulate. Squash merges defeat
`git branch --merged` (the squashed commit is not an ancestor), so clean by upstream instead:

```bash
git checkout <default> && git pull && git fetch -p
git branch -vv | awk '/: gone]/ {print $1}' | xargs -r git branch -D
```

- Always cut new branches from the freshly pulled default branch — never from another feature
  branch in a squash-merge repo (the follow-up MR will conflict once the first one squashes).
- At most one feature branch alive per repo at a time, mirroring the mr-police limit.

If the branch had a worktree, **remove the worktree in the same breath as merging it** — a merged
worktree is a stale checkout of code that no longer exists anywhere else, and they accumulate far
more quietly than branches do. `git worktree remove` deletes only the checkout; the branch ref
survives, so this is safe whenever the tree is clean:

```bash
git worktree list                       # audit BEFORE removing anything
git -C <worktree> status --porcelain    # must be empty — uncommitted work dies with the checkout
git worktree remove <worktree>
git worktree prune
```

- **Never remove a worktree with a dirty status.** Commit, stash, or leave it and say so — the
  branch ref will not save uncommitted or untracked files.
- Audit the whole list, not just the one you just merged. A repo worked by several agents
  accumulates worktrees from sessions that ended without cleaning up.
- Worktrees under a harness-managed directory (`.claude/worktrees/`, a scratch dir belonging to
  another session) are not yours to remove — another agent may be mid-turn inside one.

## Source

Adapted from Mnimiy's "12-rule CLAUDE.md template"
(https://x.com/Mnilax/status/2053116311132155938), itself building on the original four rules
attributed to Andrej Karpathy. Rule 6 from the source (per-task and per-session token budgets)
is intentionally omitted — agentkit ships static instructions and cannot enforce runtime token
caps.

<!-- agentkit:coding-discipline:end -->
