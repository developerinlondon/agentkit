---
name: release-tier
scope: external
category: release
strength: prefer
provenance: 2026-08-05 · a release was tagged a minor by semver reflex when only the release itself had been authorized
---

Cut patch releases by default. Propose the patch version and let the owner raise the tier if
they want one.

Why: "publish this" or "release this" authorizes a release, never the tier. Version numbers are
outward-facing product signalling, so the tier is a direction decision rather than a mechanical
one — and an agent reasoning from semver alone reads any feature-shaped diff as a minor and tags
it before anyone has agreed to the signal it sends.

How to apply: bump the patch component. If the change genuinely looks minor- or major-worthy,
say so in the release pull request and ask — do not tag first and mention it afterwards.
