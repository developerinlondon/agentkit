---
name: terse-merge-requests
scope: external
category: writing
strength: prefer
provenance: 2026-05-12 · "keep compact MR messages and descriptions and commit messages, we dont need giant essays"; restated 2026-07-06 for changelog entries
---

Keep merge-request titles, descriptions, commit bodies and changelog entries short and
point-form. Bullets over prose, what and why in one breath.

Why: a description is read to find out what landed, not to relive how it was built. Rationale
and history belong in the design document and the commit trail; an essay buries the one line a
reviewer came for.

How to apply: title imperative, under about seventy characters, carrying the conventional-commit
prefix. Description three to six lines — link the design document rather than restating it.
Commit body two to four lines; skip the out-of-scope and future-work block unless it is
load-bearing. A changelog entry is a bold lead plus one or two sentences, split across bullets
rather than lengthened. No test-plan section when green CI already speaks for the change.
