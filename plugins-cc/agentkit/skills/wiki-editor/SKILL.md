---
name: wiki-editor
description: Who is editing in this session, for repos whose commits must name a person (knowledgebases and wikis edited through a shared agent session). Use when the editor-police hook denies a commit, before the first commit to such a repo in a session, or when someone says a different person has taken over the keyboard. Asks once per session, records the answer, and puts that person on every commit as an Edited-by trailer so page stamps and changelogs name them.
---

# wiki-editor

Several people can edit through one agent session, so the machine identity cannot tell them
apart. This skill, with the `editor-police` hook behind it, makes every commit in a configured
repo carry the human who made it, as an `Edited-by: Name <email>` trailer. A trailer survives a
squash merge, which a commit author does not.

## The flow

1. The first `git commit` in a configured repo during a session is denied by the hook with
   `EDITOR UNKNOWN`, the session id and the names the config knows.
2. Ask with AskUserQuestion, one question: who is editing right now? Offer each known name as
   an option plus **Other** (the user types a name). Matching is case-insensitive.
3. Record it once: `wiki-editor set <name> --session <id>`.
4. Commit with the trailer written out: `--trailer="Edited-by: Name <email>"`, exactly as the
   `set` step or the refusal printed it. The unexpanded `$(wiki-editor trailer …)` form is refused:
   if the tool is not on `PATH` it substitutes to nothing and git accepts an empty trailer.
5. Never ask again in that session. If someone says another person is now editing, run
   `wiki-editor set` again; the hook then requires the new trailer.

## Configuration

`~/.config/agentkit/config.yaml`:

```yaml
editor-police:
  enabled: true
  repos: # repo path globs whose commits must name the editor
    - myorg/*/wiki
  editors: # short name -> the author string, matched case-insensitively
    ana: "Ana Example <ana@example.com>"
  fallback-email: team@example.com # for a typed name the map does not know
```

## If the refusal says `EDITOR TOOL MISSING`

The repo is configured but `wiki-editor` is not installed where the hook looks (`~/.local/bin`,
the plugin's `tools/`, then `PATH`). Run agentkit's `./install.sh --global`, or point
`WIKI_EDITOR_BIN` at the tool, then retry. Do not commit around it.

## If the refusal says `EDITOR GATE UNCHECKED`

`awk` is not on `PATH`, so the hook could not read the command. Install awk or fix `PATH`, then
retry. Do not commit around it.

## Rules

- Never guess the editor; never bypass the gate with `-c user.name` or `--no-verify`.
- The committer and the signature stay the machine's; only the trailer names the person.
- Merging by squash: pass a squash commit message that keeps the trailer, or the merged commit
  loses the name.
- Off for a session: `AGENTKIT_SKIP_HOOKS=editor-police`; off for a machine: `enabled: false`.
