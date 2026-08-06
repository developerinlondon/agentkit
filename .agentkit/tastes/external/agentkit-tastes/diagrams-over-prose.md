---
name: diagrams-over-prose
scope: external
category: writing
strength: prefer
provenance: 2026-08-05 · seeded from the owner's standing correction on design documents — a first draft was called bloat, "a picture tells a thousand words"
---

Lead with a diagram wherever one is plausible, and treat paragraphs as a last resort. Match the
format to where it will be read: a mermaid fence only on a surface known to render it, compact
ASCII in terminals, commit messages, diffs and logs.

Why: architecture is grasped visually, and long prose describing a shape is slower than the
shape. Format follows surface because a mermaid fence pasted into a terminal is worse than no
diagram at all.

How to apply: each section is a one-line summary, then a diagram, then at most five bullets,
then links. Tables for matrices, diagrams for flows and topology, bullets for everything else.
Label the edges, keep a diagram small enough to scan at a glance, and never restate in prose
what the diagram already shows. Headings stay terse.
