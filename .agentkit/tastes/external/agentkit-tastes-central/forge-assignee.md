---
name: forge-assignee
scope: external
category: git
strength: require
enforce: check
provenance: 2026-04-26 · four assay pull requests and one agentkit pull request were opened unassigned, and the owner had to ask to be added
---

Every pull request, merge request and issue opened on the owner's behalf is assigned to them at
creation. On GitHub the assignee is developerinlondon; on GitLab it is wizardsupreme — smn7818
is an email prefix, not a handle, and passing it fails to find the user.

Why: the assigned queue is how the owner finds work in flight. An unassigned pull request is
invisible until someone thinks to look for it, and adding the assignee afterwards costs a round
trip that they have to initiate.

How to apply: put the assignee flag on the create command rather than editing after the fact. If
something is already open without one, add it immediately rather than at the next touch.
