---
name: neutron-lineage
scope: external
category: secrecy
strength: require
provenance: 2026-07-12 · an external review surfaced stale design-lineage claims, and the owner had neutron's git history rewritten to purge them
---

Never mention proxima or Siemens in any bizfoundry repository — documents, code comments, commit
messages, merge requests, plans. Neutron was built ground-up on the Claude Agent SDK, and its
work predates proxima, formerly agentX.

Why: the old design-lineage attribution was false. The owner corrected the record and had
neutron's history rewritten with filter-repo across both content and commit messages, then
force-pushed — every commit hash changed. Reintroducing the words puts the claim back into a
history that was rewritten to remove it.

How to apply: describe neutron on its own terms. The live agent named Proxima Gondor in the
fullcircle infra repository is exempt — that is its product name and the owner chose to keep it.
If an old neutron clone surfaces, re-clone it rather than rebasing onto the rewritten history.
