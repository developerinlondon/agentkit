---
name: branch-from-fresh-main
scope: external
category: git
strength: require
provenance: 2026-08-05 · seeded from the owner's standing bizfoundry workflow rule, written after stale branches produced repeated merge conflicts
---

Fetch and pull the default branch immediately before cutting any branch. Never cut one from another
feature branch, and never amend — each review round is a new commit.

Why: in a squash-merge repository the squashed commit is no ancestor, so a stale base conflicts the
moment the first branch lands, and amending needs a force push, which is refused.

How to apply: prefix fix, feat, docs, refactor or chore. After a merge, pull the default branch and
delete local branches by gone upstream.
