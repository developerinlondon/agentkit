---
name: prove-tests-can-fail
scope: external
category: verification
strength: require
provenance: 2026-08-01 · a reviewer reverted a fix and got an identical pass count; two weeks earlier a suite shipped green with every path it claimed to cover dead
---

Before calling a change verified, make the new tests fail on purpose: break the exact line each new
assertion targets, confirm it dies, restore it, and report what died. For a fix, run the inverse —
revert it and check the pass count moves.

Why: a pass count measures the suite, not the property, so an identical count after reverting the
fix means nothing in the repository distinguishes fixed from broken.

How to apply: mutate scope and constants, not only presence and absence — a rule's existence is
usually pinned, its bounds are not. Test at the call site, not the helper. Check a stub can even
express the failure you claim to catch.
