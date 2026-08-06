---
name: deploy-tags-are-resolved
scope: external
category: delivery
strength: require
provenance: 2026-07-15 · a hand-typed image tag with one guessed character put both neutron instances into ImagePullBackOff for about fifteen minutes
---

Never type or eyeball a deployment image tag. Resolve it — git rev-parse at eight characters
against the remote default branch, or the tag CI pushed — and interpolate it.

Why: registry tags are exact strings, git's printed abbreviation is variable-length and is not the
CI short SHA, and neutron keeps no old pods serving, so a wrong tag is an outage.

How to apply: confirm the tag exists in the registry before merging a versions bump, and pull
immediately before editing that file — another session bumps it concurrently.
