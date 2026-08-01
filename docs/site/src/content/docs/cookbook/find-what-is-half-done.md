---
title: Find what is half done
description: Ask the repository what you started and did not finish, instead of taking an agent's summary of its own work on trust.
sidebar:
  order: 7
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
neutron — 9 half-done
 BRANCH    feat/incidents-ui           0d    1 commits  !633 open
 BRANCH    fix/core-name-everywhere    7d    0 commits  no MR/PR ever opened
 ABANDONED feat/model-catalog-auto     5d   !492 closed without merging
 WORKTREE  wt/corename2                DIRTY 11 modified, 2 untracked — do NOT remove at ~/wt/corename2
 MR/PR     !628 (fix/voice)            held: no approving review
 FILED     #311 #312 — authored, open, unfixed
 DEFERRED  #313 — carved out of other work
 PLAN      plans/057.md                2 gap(s) unclosed
 MERGED    fix/old — merged on the forge; cleanup, not unfinished work
```

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
[Configuration](/docs/reference/configuration/) for `wip.plan-paths` and `wip.issue-refs`.
