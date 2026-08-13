---
name: ruminate
description: >-
  Mine past Claude Code conversations for corrections, preferences, and
  knowledge that never reached the brain vault. Complements reflect (current
  session) and meditate (vault audit). Good for bootstrapping a vault from
  existing history. Triggers: "ruminate", "mine my history".
---

# Ruminate

Mine conversation history for vault-worthy knowledge that was never captured.
Run occasionally (weekly, monthly) or once to bootstrap a new vault.

No `brain/` vault yet → seed it first via the `reflect` skill's bootstrap.

## Process

1. **Snapshot the vault** with the `meditate` skill's `scripts/snapshot.sh`
   so each analysis subagent gets one file, not the whole tree.

2. **Locate history.** Claude Code stores per-project transcripts under
   `~/.claude/projects/<project-dir-with-slashes-as-dashes>/*.jsonl`.

3. **Extract** into readable batches (bun, no dependencies):

   ```bash
   bun <this skill's scripts/>extract-conversations.ts "$CONV_DIR" "$OUT_DIR" --batches N
   ```

   Pick N ≈ one batch per 20 conversations, min 2, max 10. `--from`/`--to`
   (YYYY-MM-DD) bound the date range; `--min-size` skips trivial files.

4. **Analyze in parallel.** One subagent per batch. Each gets: the batch's
   extracted conversations, the vault snapshot path, and this brief — find
   corrections the user gave, preferences they repeated, knowledge that never
   got captured, friction patterns. A candidate must recur across at least 3
   exchanges OR be non-obvious to a competent engineer AND not already covered;
   judge outcomes, not tone — a praised-but-wrong answer is still a failure
   worth capturing. When a finding belongs in an existing note, name only a
   note present in the vault snapshot; any other destination is a new note.
   Return candidates as `topic-slug: one-paragraph body` entries with a
   severity (high-signal / high-frequency / high-impact) justification.

5. **Merge and route.** Deduplicate candidates across batches, drop anything
   failing the quality bar, then route exactly as `reflect` does: structure
   first, then skill edits, then vault notes. Present the consolidated set
   before writing.

Other harnesses (codex, opencode) store history differently — this skill's
extractor covers Claude Code transcripts only.
