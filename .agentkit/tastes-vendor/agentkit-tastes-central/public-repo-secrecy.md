---
name: public-repo-secrecy
scope: external
category: secrecy
strength: require
enforce: check
provenance: 2026-08-05 · seeded from the owner's correction after a public assay pull request justified a version bump by naming the private consumer repository that needed it
---

The developerinlondon repositories — agentkit, assay, openclaw, claws and the rest — are public.
Nothing landing in them may name BizFoundry, fullcircle, FCAR, fcar.ai, gondor, wizardsupreme,
any internal hostname, cluster or service, any internal roadmap codename such as a phase label,
or any private design or ADR number. That covers pull-request titles and descriptions, commit
messages, README text and code comments alike.

Why: a public repository is visible to the world, and naming a private consumer reveals the
business, its architecture, which repositories exist, and who works on them. The title is the
highest-signal string of all — it appears in the public pull-request feed, in RSS and in the
squashed commit subject — and fixing it afterwards still leaves it in webhooks and CI events.

How to apply: justify a change on its own merits. A version bump exists to support downstream
consumers that pin a specific version, never because a named repository needs it. When you catch
yourself about to type a private name, substitute a generic placeholder. Check the title before
creating the pull request, not after. None of this applies inside the bizfoundry GitLab group or
other private repositories, which expect business context.
