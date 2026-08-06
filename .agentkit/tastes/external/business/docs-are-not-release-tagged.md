---
name: docs-are-not-release-tagged
scope: external
category: release
strength: require
provenance: 2026-06-13 · a messaging plan was tagged as a release candidate on the knowledgebase repository before the feature it described existed
---

Version and release-candidate tags mark a built, deployed candidate of the application and live on
the application repository alone. A design, ADR or plan is published by merging it to the default
branch, and never advances the candidate number.

Why: git history is a document's version, so tagging a plan advertises a release that has not
happened.

How to apply: revise an ADR in place and bump its version field rather than superseding it —
reading the current decision must cost one file, not a chain. A whole document set may be
snapshotted under an archive tag named for the set and the date.
