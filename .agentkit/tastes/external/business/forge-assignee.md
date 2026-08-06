---
name: forge-assignee
scope: external
category: git
strength: require
enforce: check
provenance: 2026-04-26 · four assay pull requests and one agentkit pull request were opened unassigned, and the owner had to ask to be added
---

Assign every pull request, merge request and issue opened on the owner's behalf to them at
creation. On GitHub that is developerinlondon; on GitLab it is wizardsupreme — smn7818 is an email
prefix, not a handle, and fails to resolve.

Why: the assigned queue is how the owner finds work in flight, so an unassigned request is
invisible until someone thinks to look.

How to apply: put the assignee flag on the create command, and add it to anything already open
without one.
