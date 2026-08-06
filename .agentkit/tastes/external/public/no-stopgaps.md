---
name: no-stopgaps
scope: external
category: scope
strength: require
provenance: 2026-07-19 · a half-duplex stopgap shipped along with a user-facing toggle whose server half did not exist
---

Build the correct architecture first — no rush to get things done quickly, every rush to get them
done properly. Do not ship the portable-but-wrong version as a seam, and never expose a setting
whose other half is not built: land both halves or ship neither.

Why: a stopgap is judged as the product, not as a stage, and a toggle wired to nothing is worse
than a missing feature because someone will switch it on.

How to apply: if a genuine correctness-for-speed trade arises, state it and let the owner decide
rather than deciding it yourself. The missing half is not a follow-up.
