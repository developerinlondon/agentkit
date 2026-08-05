---
name: suspect-the-instrument
scope: external
category: verification
strength: require
provenance: 2026-07-26 · five verification probes in one session returned clean results that were the harness failing rather than the code passing
---

When a probe returns a suspiciously tidy result — all zeros, all ok, nothing found — suspect
the instrument before believing the code. Make the probe fail on purpose first: if it cannot
produce a red, its green carries no information.

Why: a broken instrument and a healthy system produce the same output, and "all ok" is exactly
what "observed nothing" looks like. The inverse holds too — an unexpected red is as likely to be
the probe as the code, so confirm a mutation landed on the line you aimed at before concluding
that an assertion is weak.

How to apply: point the probe at a known-bad revision, or mutate the source, and confirm the
output changes. Check that a control row is red before trusting the green rows. Grep for the
string you expect to be absent, not only the one you expect present. Run the probe with the
consumer's settings rather than the library's defaults. Treat an empty result from a bounded
search as a fact about the bound, not about the world.
