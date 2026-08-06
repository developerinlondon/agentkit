---
name: architecture-is-the-owners-call
scope: external
category: scope
strength: require
provenance: 2026-07-20 · a reviewer's finding was treated as a mandate and a decision was moved between components without asking
---

Execution is autonomous; direction is not. Bug fixes inside an agreed design, tests, constants and
documentation are yours. Moving a decision between components, swapping a transport, vendor or
framework, reshaping the design, or adding infrastructure goes to the owner first.

Why: a finding that reads as "unfixable as designed, therefore redesign" forces a conversation, not
a redesign, and substituting your own architecture devalues the next approval.

How to apply: report the finding, state the options and your recommendation, and wait. Nothing
merges or deploys on an architecture change without the owner's word, even when the code is green.
