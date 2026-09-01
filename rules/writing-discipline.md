---
globs: "**/*.{md,mdx,markdown,txt}"
---

# Writing Discipline (Prose Police)

Applies to every piece of prose an agent writes: docs, READMEs, issue and MR bodies, commit
messages, chat replies. The `prose-police` hook enforces the mechanically detectable slice on
markdown/text writes; the rest is on the agent. Pattern content adapted from Wikipedia's
"Signs of AI writing" via blader/humanizer and conorbronsdon/avoid-ai-writing (MIT).

## Banned constructions

- **Stock AI vocabulary**: delve, tapestry, plethora, myriad of, treasure trove, synergy,
  paradigm shift, game-changer, cutting-edge, groundbreaking, revolutionize, seamless,
  holistic, leverage (the verb), embark on, harness the power, unlock the potential.
- **Significance inflation**: "a testament to", "plays a crucial role", "underscores the
  importance", "evolving landscape", "pivotal moment", "in today's fast-paced world".
- **Negative parallelism**: "not just X, but Y", "it's not X — it's Y". Say what it is.
- **Chatbot filler**: "great question", "I hope this helps", "let's dive in", "without
  further ado", "it's worth noting", "needless to say".
- **Em-dash pile-ups**: more than ~3 per 100 words. Most want a period or a comma.
- **Rule-of-three padding**: triplets of adjectives or clauses added for rhythm, not content.

## What good prose does instead

- States the specific fact plainly, with numbers and names, in active voice.
- Cuts any sentence the text survives losing.
- Varies sentence length the way a person with a point does; no press-release cadence.

For a wholesale rewrite of existing text, invoke the `humanize` skill.

Off switches: `AGENTKIT_SKIP_HOOKS=prose-police` (session), `git config
agentkit.prosepolice.enabled false` (repo), `enabled: false` under `prose-police:` in the
agentkit `config.yaml` (global).
