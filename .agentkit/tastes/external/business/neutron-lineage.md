---
name: neutron-lineage
scope: external
category: secrecy
strength: require
provenance: 2026-07-12 · an external review surfaced stale design-lineage claims, and the owner had neutron's git history rewritten to purge them
---

Never mention proxima or Siemens in any bizfoundry repository — documents, code, commit messages,
merge requests, plans. Neutron was built ground-up on the Claude Agent SDK and predates proxima,
formerly agentX.

Why: the old lineage claim was false, and neutron's history was rewritten with filter-repo and
force-pushed to purge it, so retyping the words puts it back.

How to apply: the live agent named Proxima Gondor in the fullcircle infra repository is exempt —
that is its product name. If an old neutron clone surfaces, re-clone rather than rebase.
