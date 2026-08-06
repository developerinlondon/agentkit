---
name: review-gates-the-merge
scope: external
category: review
strength: require
provenance: 2026-07-19 · a review dispatched in parallel with the merge returned a "do not ship this yet" finding after the code was already on the default branch
---

The review returns before the merge, never alongside it. A finding that says "do not ship this
yet" is blocking: fix it and re-review the new head, or take the feature out.

Why: running the review in parallel with the merge means its verdict lands on code that already
shipped, and every finding then gets read as advisory. The severity call belongs to the
reviewer; only the owner can override it.

How to apply: dispatch the reviewer against the exact head commit, wait for the verdict, and
merge only once no blocking or high finding stands. Never downgrade, reinterpret, or reason past
a finding on the grounds that it looks inert. If you disagree with one, say so to the owner and
let them decide.
