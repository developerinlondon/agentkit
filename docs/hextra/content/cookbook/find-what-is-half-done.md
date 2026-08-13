---
title: Find what is half done
weight: 5
---

`wip` is read-only. It blocks nothing, changes nothing, and answers one question across as many
repositories as you give it: **what did I start and not finish?**

```sh
wip                       # this repository
wip ~/code/a ~/code/b     # several, one block each
wip --limit 0             # no bounding
wip --no-forge            # git and plans only, no network
```

```
neutron — 4 unfinished branch(es)
 BRANCH    feat/incidents-ui           0d   1 commits  !633 open
 BRANCH    fix/core-name-everywhere    7d   0 commits  no MR/PR ever opened
 ABANDONED feat/model-catalog-auto     5d  !492 closed without merging
 WORKTREE  wt/corename2                DIRTY 11 modified, 2 untracked — do NOT remove at ~/wt/corename2
 MR/PR     !633 (feat/incidents-ui)    held: no approving review
 FILED     #311 #312 — authored, open, unfixed
 DEFERRED  #313 — carved out of other work
 PLAN      plans/057.md                2 gap(s) unclosed
 COUNTS    1 abandoned · 20 worktree(s) · 2 open change(s) · 100 filed issue(s) · 1 plan(s) with gaps
 NOTE      20 branch(es) hidden: nothing committed, no worktree, no change ever opened
 MERGED    fix/old — merged on the forge; cleanup, not unfinished work
```

## What the headline counts, and what is hidden

The headline is **unfinished branches only**. Branches, worktrees, issues and plan gaps are four
different kinds of thing with four different remedies, so summing them into one number gives a
figure nobody can act on. The rest are broken out on the `COUNTS` line.

A branch is hidden when **nothing was committed, no worktree is checked out on it, and no change
was ever opened**. Nothing was started, so there is nothing to finish. On one real repository that
removed 20 of 41 branches — all created by a worktree harness — and took the headline from a
meaningless 150 to an actionable 4.

The test is structural, never by name. A `worktree-agent-*` pattern would look tidier and is worse:
it would hide such a branch that _does_ carry commits, which is real unfinished work. Having commits
disqualifies a branch from being hidden, so this rule cannot make that mistake. Nor can it hide the
case that matters most — a branch with no commits but a **dirty worktree**, where uncommitted work
actually lives; the worktree keeps it visible.

Whatever is hidden is counted and stated in a `NOTE`. Silent omission reads as "nothing else to see".

## Read the rows in this order

**`DIRTY` worktrees first.** Uncommitted and untracked files die with the checkout and no branch ref
carries them. Commit, stash, or leave it alone — never remove a dirty one.

**`no MR/PR ever opened` next.** That is work that exists only on your machine. Everything else is
at least visible to someone.

**`ABANDONED` is not a problem to fix.** A change closed without merging was a decision. It appears
so that a deliberate stop is not mistaken for a forgotten one.

**`MERGED` is cleanup, not work.** The content landed; only the local ref is left.

```sh
git checkout main && git pull && git fetch -p
git branch -vv | awk '/: gone]/ {print $1}' | xargs -r git branch -D
```

## Trust the NOTE rows

An absent section means "nothing found". A `NOTE` means "not looked at" — they are never conflated,
and a bounded list always says how many entries it dropped.

The one to take seriously:

```
NOTE  branch state is DEGRADED: only the forge can tell a squash-merged branch
      from an unfinished one, so no branch above is known to be outstanding
```

Whether a branch is finished is the forge's answer, not git's — a squash merge destroys the
topological evidence, so every git-only rule reports merged branches as outstanding forever. With no
forge reachable, `wip` reports that it does not know rather than guessing in the alarming direction.
`--no-forge` produces the same honest degradation deliberately.

## Before you call a plan done

The `PLAN` rows come from `plan-gate`, which reads a plan's own gaps section:

```sh
plan-gate                  # every plan under this repository
plan-gate --require-done   # only plans that already claim to be finished
```

A gap stops blocking when you tick it (`- [x] …`), strike it through, or name the issue that now
carries it (`#123`, `!123`, `GH-123`, or the issue URL). `plan-police` runs the same checker on any
edit that marks a plan done and refuses the edit while a bare gap stands — filing the issue and
pasting its number is the fix.

Plan layout is discovered from six common roots and is configurable per repository; see
[Configuration](/reference/configuration/) for `wip.plan-paths` and `wip.issue-refs`.
