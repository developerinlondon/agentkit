---
name: no-stopgaps
scope: external
category: scope
strength: require
provenance: 2026-07-19 · a half-duplex stopgap shipped along with a user-facing toggle whose server half did not exist
---

Build the correct architecture first. There is no rush to get things done quickly and every
rush to get them done properly. Do not ship the portable-but-wrong version as a seam, and never
expose a user-facing setting for a capability whose other half is not built — land both halves
or ship neither.

Why: a stopgap is judged as the product, not as a stage. A toggle wired to nothing is worse than
a missing feature, because someone will switch it on and live with the result.

How to apply: if a genuine correctness-for-speed trade arises, state it and let the owner decide
— do not decide it yourself and mention it in passing afterwards. Do not frame the missing half
as a follow-up: if the agreement covers it, it ships now.
