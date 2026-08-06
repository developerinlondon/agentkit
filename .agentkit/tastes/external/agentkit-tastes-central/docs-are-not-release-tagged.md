---
name: docs-are-not-release-tagged
scope: external
category: release
strength: require
provenance: 2026-06-13 · a messaging plan was tagged as a release candidate on the knowledgebase repository before the feature it described existed
---

Version and release-candidate tags mark a built, deployed candidate of the application that
actually ships, and they live on the application repository alone. A knowledgebase document — a
design, an ADR, a plan — is published by merging it to the default branch, never by a version
tag, and a documentation change never advances the release-candidate number.

Why: git history is a document's version, and the latest revision on the default branch is the
canonical one. Tagging a plan advertises a release that has not happened; the next candidate
number is the next time code actually ships.

How to apply: revise an ADR in place and bump its version field rather than writing a superseding
ADR or inlining the old text — earlier revisions are recoverable from earlier commits, so reading
the current decision must cost one file rather than a supersede chain. Plans stay living until
the work ships and then become historical. A wholesale replacement of a document set may be
snapshotted under an archive tag named for the set and the date.
