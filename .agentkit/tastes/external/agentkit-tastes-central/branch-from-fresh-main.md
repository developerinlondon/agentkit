---
name: branch-from-fresh-main
scope: external
category: git
strength: require
provenance: 2026-08-05 · seeded from the owner's standing bizfoundry workflow rule, written after stale branches produced repeated merge conflicts
---

Fetch and pull the default branch immediately before cutting any branch, in every repository.
Each round of review is a new commit, never an amend.

Why: branching from a stale checkout is where merge conflicts come from. In a squash-merge
repository a branch cut from another feature branch conflicts the moment the first one squashes,
because the squashed commit is not an ancestor of anything. Amending rewrites history and then
needs a force push, which is refused.

How to apply: fetch, check out the default branch, pull, then create the branch — never cut one
from another feature branch. Use the conventional prefix: fix, feat, docs, refactor, chore. Push
a new commit for every review round. After a merge, return to the default branch, pull, and
delete the local branch by its gone upstream rather than by merged-ness, which squashing defeats.
