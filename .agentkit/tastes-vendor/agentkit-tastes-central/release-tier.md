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

Releases default to a patch bump, in every repository — agentkit, assay, neutron, all of them.
A minor or major version is cut only when the owner has explicitly agreed to that tier
beforehand, for that specific release.

Why: "publish this" or "release this" authorizes a release, never the tier. Version numbers are
outward-facing product signalling, which makes the tier a direction-class decision the owner
owns. An agent reasoning from semver alone tags a minor for any feature-shaped diff.

How to apply: bump the patch component. If the change genuinely feels tier-worthy — new feature
surface, a breaking change — say so in prose and ask before tagging; never tag first. Once the
owner has agreed to a minor or major for this release, set AGENTKIT_RELEASE_TIER on the tag
command so the decision is visible in the transcript rather than inferred from the tag.
