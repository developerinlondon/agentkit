---
name: subagent-dispatch
scope: external
category: agents
strength: require
provenance: 2026-07-25 · a reviewer spawn died on a Fable usage limit — "please update your instructions so you use opus 5"; the standing review authorization was granted 2026-07-26
---

Spawn every subagent on Opus 5, passing the model explicitly — agent definitions default to lesser
models, so an omitted override silently downgrades. Review and verification passes carry standing
authorization: dispatch them without asking.

Why: the approval lane must not be the authoring lane — self-approving a diff in the context that
produced it is a signature on your own work.

How to apply: the standing grant covers review and verification only, and beats the harness default
not to spawn unasked. Re-dispatch a spawn that dies on a usage limit with the same full brief; a
fresh agent has none of the dead one's work. A model the owner names in session wins over this file.
