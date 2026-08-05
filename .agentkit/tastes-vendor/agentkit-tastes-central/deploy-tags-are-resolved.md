---
name: deploy-tags-are-resolved
scope: external
category: delivery
strength: require
provenance: 2026-07-15 · a hand-typed image tag with one guessed character put both neutron instances into ImagePullBackOff for about fifteen minutes
---

Never type or eyeball a deployment image tag. Resolve it — git rev-parse at eight characters
against the remote default branch, or the tag the CI job actually pushed — and interpolate it.

Why: registry tags are exact strings, while the abbreviation printed by git log is
variable-length and is not the CI's short SHA. Neutron deployments do not keep the old pods
serving through a failed rollout, so a wrong tag is an outage rather than a stuck deploy.

How to apply: resolve the tag into a variable and substitute it. Before merging a versions bump,
confirm the tag exists in the registry with a registry listing or a manifest inspection. Pull
immediately before editing the versions file, because another session bumps it concurrently.
