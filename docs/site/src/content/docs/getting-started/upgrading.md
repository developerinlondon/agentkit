---
title: Upgrading and removing
description: What a second install run does to each class of installed file, and why removal is manual.
sidebar:
  order: 4
---

Re-running the installer _is_ the upgrade. There is no version file, no install manifest and no
timestamp. The state it leaves behind is the remembered group selection, your seeded config file,
and the marker blocks it writes into files you also own.

## What a second run does

| Class                                     | On re-run                                |
| ----------------------------------------- | ---------------------------------------- |
| skills, rules, tools, hooks, plugins      | overwritten unconditionally              |
| shell profile, client configs             | marker-guarded, never duplicated         |
| `~/.config/agentkit/config.yaml`          | preserved — seeded once, then left alone |
| artifacts unsupported on this platform    | actively removed                         |
| artifacts of an unselected explicit group | actively removed                         |

:::caution[Local edits inside an installed skill are destroyed on upgrade]
An existing skill directory is removed and re-copied. Edit the clone, not the install.
:::

Two more details:

- **Deselecting an ordinary group never deletes anything.** An already-installed skill from an
  unselected group is still refreshed, and the installer says so. Deselection changes what is
  chosen, never what is on disk, so an upgrade never removes a skill you are using.
- **An unselected explicit group is the exception.** `strict-review` is consent-gated: when it is
  not selected, its hooks, tools, skills and prompt wiring are removed. Presence without recorded
  selection is not consent.

Config files carrying your own content are guarded by markers or predicates, so re-runs do not
duplicate blocks. In `CLAUDE.md` those markers look like
`<!-- agentkit:<name>:start -->` / `<!-- agentkit:<name>:end -->`; removal strips exactly that
span. Blocks that older versions appended without markers are still found by their heading and
removed.

## Removing it

:::danger[There is no uninstaller]
The kit ships no uninstall script and no `--uninstall` flag. Removal is manual.
:::

What has to be removed is whatever the installer wrote. Read
[`install.sh`](https://github.com/developerinlondon/agentkit/blob/main/install.sh) for that,
rather than a list here that could fall behind it.

The one thing worth knowing up front: dropping the _files_ is not the whole job. The installer
also edits configs you own — `~/.claude/settings.json`, `~/.claude/CLAUDE.md`,
`~/.config/opencode/opencode.json`, `$CODEX_HOME/config.toml`, `$CODEX_HOME/hooks.json` and
`~/.bashrc`. Those edits stay until you remove them.
