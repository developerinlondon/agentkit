---
name: cross-repo-links
scope: external
category: writing
strength: require
provenance: 2026-05-10 · flagged twice in one day — "you are again referencing files in other folders / repos using relative paths, can you stop doing this please"
---

Inside the bizfoundry workspace, a link to a file in a different repository is an absolute GitLab
URL. Relative paths are only ever for a target in the same repository.

Why: what looks like one tree on disk is a set of separate GitLab projects under groups and
subgroups. GitLab renders each repository standalone, so a relative path resolves within the
current file's repository only, and a cross-repo one produces a dead link. The local layout is
exactly what makes this look right every time it is wrong.

How to apply: before writing any markdown link in a bizfoundry repository, ask whether the target
lives in this repository. If it does, a relative path is fine. If it does not, build the full
URL under gitlab.com for that group and repository — never a parent-relative path across
repositories. Mentioning the repository by name with no link is also acceptable; pick one
convention per file.
