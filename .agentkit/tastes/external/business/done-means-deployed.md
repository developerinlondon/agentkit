---
name: done-means-deployed
scope: external
category: delivery
strength: require
enforce: check
provenance: 2026-07-26 · a change was reported "fixed" three times while it sat on a branch and then on a stale review — "you dont seem to understand the definition of done"
---

Never write "fixed", "done" or "working" about anything the owner cannot currently see. Done, for a
user-facing change, is plan, code, review, merge, deploy, verify on the live instance, then report
with the URL and what to click.

Why: they judge done by whether it works when they use it, and neutron has no auto-bump, so the
default branch runs nowhere until its image tag lands in gitops.

How to apply: before saying done, know what tag is running, whether it contains your commit, and
whether you saw the behaviour yourself. Until then say committed, in review, or merged and not
deployed. Name the instance to test on, and flag what is only test-verifiable.
