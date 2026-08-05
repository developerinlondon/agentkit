---
name: design-doc-shape
scope: external
category: writing
strength: prefer
provenance: 2026-08-05 · seeded from the owner's correction during the content-app-stack docs cleanup — "agent friendly and an ai agent can navigate these without issues"
---

A design or ADR is named for its subject, never for the rollout slot it sits in, and reads at the
diagram-and-prose level. Operational detail — environment variables, SQL, Lua, sync-wave tables,
secret-key listings — lives in the component's own README, next to the code.

Why: a phase label is a work-tracking artefact and means nothing once the phase is forgotten. The
goal is that an agent or a new engineer can understand the shape of the system from the designs
directory alone, and predictable structure with clean separation matters more than completeness
in any one file.

How to apply: name a new design for what it is about. When a design starts accumulating
environment-variable tables or SQL, push that detail into the component README and cross-link
both ways. A component README follows the established shape — layout table, prerequisites,
secret-stitch diagram, sync waves, verification, then the app-specific quirks.
