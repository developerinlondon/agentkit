---
name: plan-folders
scope: external
category: writing
strength: prefer
provenance: 2026-08-05 · seeded from the owner's convention — "this is a plan file broken down into multiple files, since we want to honour a 1000 line limit"
---

A bizfoundry plan is a numbered folder, not a single file: a terse README index plus numbered
sub-files, one concern each, capped at roughly a thousand lines.

Why: a long single-file plan is unreviewable, and numbered sub-files force one topic per file and
keep the diff tractable.

How to apply: the README is an index only, one line per sub-file, beside an overview sub-file
carrying the architecture at a glance. Folder numbering is independent of the plan's own number.
Split once a sub-file outgrows the cap.
