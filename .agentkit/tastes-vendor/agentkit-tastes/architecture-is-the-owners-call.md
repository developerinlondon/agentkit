---
name: architecture-is-the-owners-call
scope: external
category: scope
strength: require
provenance: 2026-07-20 · a reviewer's finding was treated as a mandate and a decision was moved between components without asking
---

Execution is autonomous; direction is not. Fixing bugs inside an agreed design, adding tests,
tuning constants and correcting documentation are yours. Moving a decision between components,
swapping a transport, vendor or framework, changing the shape of the design, or adding
infrastructure goes to the owner first.

Why: a review finding feels like it forces a redesign — "unfixable as designed, therefore
redesign". It does not; it forces a conversation. Substituting your own architecture for the
agreed one is the failure that makes the next approval worth less.

How to apply: when a finding implies a redesign, report the finding, state the options and your
recommendation, and wait. Do not dispatch an implementer first and surface the decision
afterwards. Nothing merges or deploys on an architecture change without the owner's word, even
when the code is finished and green.
