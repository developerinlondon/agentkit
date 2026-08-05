---
name: plan-folders
scope: external
category: writing
strength: prefer
provenance: 2026-08-05 · seeded from the owner's convention — "this is a plan file broken down into multiple files, since we want to honour a 1000 line limit"
---

A bizfoundry plan is a numbered folder rather than a single file: a terse README index plus
numbered sub-files, each covering one concern and capped at roughly a thousand lines.

Why: a long single-file plan is unreviewable and forces scrolling. Numbered sub-files force one
topic per file and keep the diff tractable.

How to apply: start a new plan with the folder README and an overview sub-file carrying the
architecture at a glance. Numbering inside the folder is independent of the plan's own number.
Split a sub-file further once it outgrows the cap. The README is an index only — one line per
sub-file. Implementation detail still belongs in the component README rather than the plan.
