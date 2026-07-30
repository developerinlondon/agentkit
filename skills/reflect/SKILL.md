---
name: reflect
description: >-
  Persist learnings from the current session into the project's brain vault — after
  mistakes, corrections, or notable codebase discoveries, or when wrapping up.
  Structural enforcement beats notes: route recurring lessons into hooks, lint
  rules, or skill edits instead. Triggers: "reflect", "remember this".
---

# Reflect

Review the conversation and persist what future sessions need — to `brain/`, to a
skill, or as structural enforcement. Never a memory dump: only what would change
a future session's behaviour.

## Vault bootstrap

If `brain/` does not exist at the project root, seed it first by copying this
skill's `references/starter-vault/` directory to `brain/` (the starter index and
principles). The vault is an Obsidian-compatible tree: `brain/index.md` (bare
`[[wikilink]]` index, rebuilt automatically by the `brain-index` hook) plus one
topic per file.

## Process

1. **Read `brain/index.md`** — know what already exists.
2. **Scan the conversation** for: mistakes and corrections, user preferences,
   codebase knowledge (architecture, gotchas), tool/library quirks, decisions and
   their rationale, repeated manual steps.
3. **Skip** anything trivial, transient, or already captured.
4. **Route each learning** (order matters):
   - **Structure first.** Can it be a hook, lint rule, script, or check? Encode it
     there and write no note — see `[[principles/encode-lessons-in-structure]]`.
     In agentkit-managed projects that usually means a police hook or a rule file.
   - **Skill edit.** About how a specific skill should work? Edit that skill.
   - **Brain note.** Everything else durable: one topic per file, filename is the
     topic slug, group under a directory (`principles/`, `codebase/`, `tools/`).
   - **Issue.** Follow-up work too big for reflection gets filed in the tracker,
     never left as a TODO in a note.
5. **Never store secrets** — no tokens, passwords, keys, or personal data in the
   vault, ever. The vault may later sync beyond this machine.

## Writing conventions

- One topic per file; short, declarative, high-signal. If Claude would get it
  right without the note, delete the note.
- Open every note with a retrieval cue: `Use when: <the task, error, or tool
  this applies to>` — concrete, never a restatement of the title.
- Link related notes with `[[wikilinks]]`. Index files hold links only, no prose.
- Convert relative dates to absolute ones.
- Judge outcomes, not tone: a solution the user praised but later corrected is
  a mistake worth capturing.

## Summary format

```
## Reflect Summary
- Brain: <files created/updated, one line each>
- Skills: <skill files modified>
- Structural: <hooks/rules/checks added>
- Issues: <follow-ups filed>
```
