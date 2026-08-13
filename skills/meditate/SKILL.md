---
name: meditate
description: >-
  Audit and evolve the project's brain vault — prune stale or low-value notes,
  surface unstated principles hiding across entries, and cross-check skills
  against the vault for missed structural enforcement. Run periodically, after
  the vault has accumulated content. Triggers: "meditate", "audit the brain".
---

# Meditate

**Quality bar:** a note earns its place by being **high-signal** (the agent
would reliably get this wrong without it), **high-frequency** (comes up in most
sessions of a type), or **high-impact** (getting it wrong is expensive).
Everything else is pruned. A lean vault outperforms a comprehensive one — every
surviving note costs context in every future session. Pruning is the
destructive direction: an ambiguous or unsupported audit verdict KEEPS the
note; delete only on positive evidence of staleness or redundancy.

No `memory/` vault in this project → say so and stop.

Audit the vault's own notes only. `memory/external/` is a vendored snapshot of a
declared source: pruning it deletes nothing durable — the next sync restores it —
and the words there are someone else's to edit, upstream.

## Process

1. **Snapshot.** Build single-file snapshots so subagents read one artifact,
   not a tree:

   ```bash
   bash <this skill's scripts/>snapshot.sh memory/ /tmp/memory-snapshot.md
   bash <this skill's scripts/>snapshot.sh <skills dir> /tmp/skills-snapshot.md
   ```

2. **Audit** (subagent, blocking). Give it the brain snapshot plus the
   project's agent-instruction files (CLAUDE.md / AGENTS.md). It reports, per
   note: stale (contradicted by the current code), redundant (duplicates
   another note, a rule, or enforced behaviour), low-value (fails the quality
   bar), verbose (same signal possible in fewer lines), or orphaned (nothing
   links to it and its topic is dead). Fewer than 3 actionable findings →
   skip step 3.

3. **Synthesize** (subagent). Inputs: both snapshots plus the audit report.
   It proposes missing `[[wikilinks]]`, flags tensions between principles,
   distills recurring patterns into candidate principles (a new principle needs
   2+ supporting notes, independence from existing ones, and a behavioural
   consequence), and cross-references skills against the vault: contradictions,
   instructions that should become structural enforcement, redundancy.

4. **Apply.** Present a consolidated summary, then apply the accepted changes
   directly — delete prunable notes rather than marking them; route
   skill-specific findings into the skill files themselves. The user reviews
   the diff.

Findings that need real follow-up work become tracker issues, not vault notes.
