---
name: cross-repo-links
scope: external
category: writing
strength: require
provenance: 2026-05-10 · flagged twice in one day — "you are again referencing files in other folders / repos using relative paths, can you stop doing this please"
---

Inside the bizfoundry workspace, a link to a file in another repository is an absolute gitlab.com
URL. Relative paths are only for a target in the same repository.

Why: what looks like one tree on disk is separate GitLab projects, each rendered standalone, so a
relative path across repositories is a dead link.

How to apply: naming the repository without a link is also fine; pick one convention per file.
