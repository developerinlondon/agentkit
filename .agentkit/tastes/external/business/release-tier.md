---
name: release-tier
scope: external
category: release
strength: require
enforce: block
rule:
  kind: command
  match: '(git tag|git push|gh release create)\b.*\bv[0-9]+\.[0-9]+\.0\b'
  remedy: Cut a patch tag instead. A minor or major tier needs the owner's explicit agreement for this specific release — propose it in the release pull request and wait for their word.
  override: AGENTKIT_RELEASE_TIER
provenance: 2026-08-05 · agentkit — told to "publish this version", tagged v0.8.0 by semver reflex with nobody having approved a minor
---

Releases default to a patch bump, in every repository. A minor or major version is cut only when
the owner has explicitly agreed to that tier beforehand, for that release.

Why: "publish this" authorizes a release, never the tier — version numbers are outward-facing
signalling, so the tier is the owner's call, and semver reflex reads any feature-shaped diff as a
minor.

How to apply: if the change feels tier-worthy, say so and ask rather than tag. Once the owner
agrees, set AGENTKIT_RELEASE_TIER on the tag command so the decision shows in the transcript.
