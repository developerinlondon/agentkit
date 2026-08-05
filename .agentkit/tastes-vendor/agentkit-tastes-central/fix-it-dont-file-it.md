---
name: fix-it-dont-file-it
scope: external
category: workflow
strength: require
provenance: 2026-08-05 · the owner's correction after a one-line default was filed as an issue instead of fixed during the session that found it
---

A finding you can fix in the session that found it gets fixed in that session. Filing is for work
that genuinely does not fit — a shape change, a decision that is not yours, a fix that needs its
own design.

Why: an issue is a promise to a future session, and a future session costs a full re-orientation
to repeat work that was already loaded in the head that found it. Trivia in the backlog also
buries the findings that actually need scheduling.

How to apply: when a review, a probe or your own use turns up a defect, ask whether the fix is
bounded and obvious. If it is — a default argument, a wrong message, a scope bug, a missing
await — fix it now, with the test that proves it, on the branch you are already on or a fresh
one. File only what you are not doing: name why it does not fit, and say so in the report rather
than presenting the issue as if it were the work.
