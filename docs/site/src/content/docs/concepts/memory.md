---
title: The memory kit
description: A per-project brain vault the agent reads at session start, plus a learning loop — reflect, meditate, ruminate — that routes recurring lessons into enforcement instead of notes.
sidebar:
  order: 9
---

AgentKit's police hooks enforce lessons someone already learned. The memory kit closes the other
half of that loop: capturing what a session taught, and deciding where it belongs.

The store is deliberately boring — `brain/` at the project root, an Obsidian-compatible tree of
markdown notes with a `brain/index.md` of bare `[[wikilinks]]`. Two small hooks do the plumbing:
`brain-inject.sh` prints the index at session start so the agent knows what knowledge exists, and
`brain-index.sh` deterministically rebuilds the index after any write inside `brain/`. Both are
silent no-ops in projects without a vault, so the kit is safe to install globally.

Three skills form the loop:

- **reflect** runs at session end or after a correction. It scans the conversation for mistakes,
  preferences, and discoveries, then routes each one. Its first question is never "which note?" but
  "can this be a hook, lint rule, or script instead?" — a recurring lesson encoded structurally
  needs no note at all. One-off knowledge becomes a vault note; skill-shaped lessons edit the skill.
- **meditate** audits the vault periodically against a hard quality bar: a note survives only if it
  is high-signal, high-frequency, or high-impact. It prunes, proposes missing links, distills
  recurring patterns into principles, and cross-checks skills against the vault.
- **ruminate** mines past Claude Code conversations for what reflect never captured — good for
  bootstrapping a vault from months of existing history. Its extractor turns transcript JSONL into
  batches that parallel subagents analyze.

Every note costs context in every future session, which is why the loop is biased toward deletion
and structural encoding. A lean vault outperforms a comprehensive one.

Two rules protect the vault's future: no secrets in notes, ever — a vault may later be shared or
synced beyond one machine — and all skill or vault changes land as diffs a human reviews, never as
silent self-modification.

Like every optional kit, deselecting it later (`--without memory`) removes the AgentKit-managed
skills, hooks, settings entries, prompts, and plugin on that install. A later bare install keeps it
absent until `--with memory` selects it again.

The kit is opt-in:

```sh
curl -fsSL https://raw.githubusercontent.com/developerinlondon/agentkit/main/kits/memory | bash
```

The vault layout and learning-loop design adapt
[brainmaxxing](https://github.com/poteto/brainmaxxing) (MIT) to AgentKit's kit and enforcement
model.
