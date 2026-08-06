---
name: suspect-the-instrument
scope: external
category: verification
strength: require
provenance: 2026-07-26 · five verification probes in one session returned clean results that were the harness failing rather than the code passing
---

When a probe returns a suspiciously tidy result — all zeros, all ok, nothing found — suspect the
instrument before believing the code. Make it fail on purpose first: a probe that cannot produce a
red carries no information when green.

Why: a broken instrument and a healthy system produce the same output, and an unexpected red is as
likely to be the probe as the code.

How to apply: point the probe at a known-bad revision, or mutate the source, and confirm the output
changes. Check a control row is red before trusting green rows. Grep for the absence, not only the
presence. Run with the consumer's settings, not the library's defaults. Treat an empty bounded
search as a fact about the bound.
