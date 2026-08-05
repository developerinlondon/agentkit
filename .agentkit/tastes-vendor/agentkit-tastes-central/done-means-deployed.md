---
name: done-means-deployed
scope: external
category: delivery
strength: require
enforce: check
provenance: 2026-07-26 · a change was reported "fixed" three times while it sat on a branch and then on a stale review — "you dont seem to understand the definition of done"
---

Never write "fixed", "done" or "working" about anything the owner cannot currently see. Done, for
a user-facing change, is plan, code, review, merge, deploy, verify on the live instance, then
report — with the URL and what to click.

Why: merged is an internal milestone that means nothing to the person who asked for the feature;
they judge done by whether it works when they use it. Neutron has no auto-bump, so the default
branch is running nowhere until the image tag lands in the gitops versions file. Reporting
completion early invites "so is it actually finished?" and spends their attention chasing you.

How to apply: before saying done, answer three things — what image tag is running, whether it
contains your commit, and whether you saw the behaviour on the instance yourself. Until then the
only honest words are committed, in review, or merged and not deployed; progress on intermediate
states is better not reported at all, because it reads as a completion claim. Name the instance
to test on. When part of a change cannot be observed by using it, say which parts are
user-verifiable and which are only test-verifiable.
