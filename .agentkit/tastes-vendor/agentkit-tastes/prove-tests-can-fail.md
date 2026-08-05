---
name: prove-tests-can-fail
scope: external
category: verification
strength: require
provenance: 2026-08-01 · a reviewer reverted a fix and got an identical pass count; two weeks earlier a suite shipped green with every path it claimed to cover dead
---

Before calling a change verified, make the new tests fail on purpose. Break the exact line of
production code each new assertion targets, confirm that assertion dies, restore it, and report
what died. For a fix, run the inverse: revert it and check the pass count moves.

Why: a pass count measures the suite, not the property. If reverting the fix leaves the number
identical, nothing in the repository distinguishes the fixed behaviour from the broken one, and
the next reader has no signal the behaviour was ever deliberate. A test that passes against a
fake the production path can never produce is worse than no test — it launders an assumption
into evidence.

How to apply: mutate the scope and the constants, not only presence and absence. The existence
of a rule is usually pinned; its bounds and its range endpoints usually are not. Test at the
call site rather than the helper, so a caller that quietly stopped using the helper is still
caught. Check that a stub can even express the failure you claim to catch. Then say which
mutations you ran and which tests died.
