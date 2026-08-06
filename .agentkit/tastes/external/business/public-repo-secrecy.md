---
name: public-repo-secrecy
scope: external
category: secrecy
strength: require
enforce: check
provenance: 2026-08-05 · seeded from the owner's correction after a public assay pull request justified a version bump by naming the private consumer repository that needed it
---

The developerinlondon repositories — agentkit, assay, openclaw, claws and the rest — are public.
Nothing in them may name BizFoundry, fullcircle, FCAR, fcar.ai, gondor, wizardsupreme, any internal
hostname, cluster, service or roadmap codename, or any private design or ADR number, in titles,
descriptions, commit messages, README text or code comments.

Why: naming a private consumer reveals the business, its architecture, which repositories exist and
who works on them, and the title survives in the public feed, webhooks and CI events even after an
edit.

How to apply: a version bump supports downstream consumers that pin a version, never a named
repository. Check the title before creating the request. Private repositories are exempt.
