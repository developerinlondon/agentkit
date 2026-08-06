---
name: terse-merge-requests
scope: external
category: writing
strength: prefer
provenance: 2026-05-12 · "keep compact MR messages and descriptions and commit messages, we dont need giant essays"; restated 2026-07-06 for changelog entries
---

Keep merge-request titles, descriptions, commit bodies and changelog entries short and point-form:
bullets over prose, what and why in one breath.

Why: a description is read to find out what landed, not to relive how it was built, and an essay
buries the one line a reviewer came for.

How to apply: title imperative, under about seventy characters, conventional-commit prefix.
Description three to six lines, linking the design document rather than restating it. Commit body
two to four lines. A changelog entry is a bold lead plus one or two sentences. No test-plan section
when green CI speaks for the change.
