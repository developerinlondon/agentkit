---
name: diagrams-over-prose
scope: external
category: writing
strength: prefer
provenance: 2026-08-05 · seeded from the owner's standing correction on design documents — a first draft was called bloat, "a picture tells a thousand words"
---

Lead with a diagram wherever one is plausible; paragraphs are a last resort. Match format to
surface: a mermaid fence only where it is known to render, compact ASCII in terminals, commit
messages, diffs and logs.

Why: architecture is grasped visually, and a mermaid fence pasted into a terminal is worse than no
diagram at all.

How to apply: one-line summary, diagram, at most five bullets, then links. Tables for matrices,
diagrams for flows and topology. Label the edges, keep it scannable at a glance, and never restate
in prose what it shows.
