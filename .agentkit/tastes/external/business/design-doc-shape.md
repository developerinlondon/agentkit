---
name: design-doc-shape
scope: external
category: writing
strength: prefer
provenance: 2026-08-05 · seeded from the owner's correction during the content-app-stack docs cleanup — "agent friendly and an ai agent can navigate these without issues"
---

Name a design or ADR for its subject, never for the rollout slot it sits in, and keep it at
diagram-and-prose level. Operational detail — environment variables, SQL, Lua, sync waves, secret
listings — belongs in the component's README.

Why: a phase label means nothing once the phase is forgotten, and an agent should grasp the shape
of the system from the designs directory alone.

How to apply: push accumulating detail into the component README and cross-link both ways. That
README's shape: layout table, prerequisites, secret-stitch diagram, sync waves, verification,
quirks.
