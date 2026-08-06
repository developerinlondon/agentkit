---
name: subagent-dispatch
scope: external
category: agents
strength: require
provenance: 2026-07-25 · a reviewer spawn died on a Fable usage limit — "please update your instructions so you use opus 5"; the standing review authorization was granted 2026-07-26
---

Spawn every subagent on Opus 5. Review and verification passes carry standing authorization:
dispatch them without asking, and do not re-litigate that each session.

Why: the approval lane must not be the authoring lane — self-approving a diff in the context that
produced it is a signature on your own work. The harness ships a default directive not to call
the agent tool unless the user asked; that is a default for sessions with no rule of their own,
and this owner has one, so it loses. Fable spawns died on usage limits repeatedly, twice
mid-flight, losing everything the agent had done.

How to apply: pass the opus model explicitly on every spawn — agent definitions default to lesser
models, so an omitted override silently downgrades. The standing grant covers review and
verification lanes only; ordinary research and implementation fan-out still follows the harness
default. If a spawn dies on a limit, re-dispatch with the same full brief — a fresh agent has
none of the dead one's work — and say the model changed and why. If the owner names a different
model in the session, theirs wins over this file.
