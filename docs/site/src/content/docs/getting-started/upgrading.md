---
title: Upgrading and removing
description: What a second install run does to each class of installed file, and what --uninstall takes back.
sidebar:
  order: 4
---

Re-running the installer _is_ the upgrade. There is no version file, no install manifest and no
timestamp. The state it leaves behind is the remembered kit selection, your seeded config file,
and the marker blocks it writes into files you also own.

## What a second run does

| Class                                    | On re-run                                |
| ---------------------------------------- | ---------------------------------------- |
| skills, rules, tools, hooks, plugins     | overwritten unconditionally              |
| shell profile, client configs            | marker-guarded, never duplicated         |
| `~/.config/agentkit/config.yaml`         | preserved — seeded once, then left alone |
| artifacts unsupported on this platform   | actively removed                         |
| artifacts of any unselected optional kit | actively removed                         |

:::caution[Local edits inside an installed skill are destroyed on upgrade]
An existing skill directory is removed and re-copied. Edit the clone, not the install.
:::

Two more details:

- **Selection is the installed set.** Deselecting `memory`, `product`, or either review kit removes
  its AgentKit-managed skills, hooks, tools, prompts, settings entries, and plugins. Otherwise a
  harness could continue to discover and auto-trigger a workflow the user removed.
- **Explicit controls how a kit is selected, not how it is removed.** `advisory-review` and
  `adversarial-review` are never offered by the picker or included by `--all`; only a literal
  `--with` selects them. Like every optional kit, a remembered selection keeps them installed and
  `--without` removes them.

Config files carrying your own content are guarded by markers or predicates, so re-runs do not
duplicate blocks. In `CLAUDE.md` those markers look like
`<!-- agentkit:<name>:start -->` / `<!-- agentkit:<name>:end -->`; removal strips exactly that
span. Blocks that older versions appended without markers are still found by their heading and
removed.

Observed on a second bare `--global` over the same install: exit 0, **29** `Updating:` lines and
**0** `Installing:` lines, `[config] Existing config preserved`, and still exactly 5 marker blocks
in `CLAUDE.md` and 5 entries in the OpenCode `instructions[]` array rather than 10.

## Removing one kit

`--without <kit>` drops a kit from the selection and remembered set, then removes that kit's
AgentKit-managed artifacts:

| Kit                                     | `install.sh --global --without <kit>`                                    |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `adversarial-review`, `advisory-review` | Removes managed instructions, skills, hooks, tools, prompts, and plugins |
| `memory`, `product`                     | Removes managed skills, hooks, settings entries, prompts, and plugins    |

Real directories and plugins that AgentKit does not own remain untouched. A real directory using
the same name as an AgentKit skill is reported instead of deleted from a client skill directory;
the canonical `~/.agentkit/skills` tree remains installer-owned and is reconciled exactly.

## Removing all of it

```sh
./install.sh --global --uninstall                  # undo a global install
./install.sh --uninstall ~/code/my-project         # undo a project install
./install.sh --global --uninstall --purge-config   # ...and drop config.yaml too
```

Run it from a checkout of the repo that installed it: artifacts are removed by the names that
checkout ships and by symlinks pointing into `~/.agentkit`, never by pattern. It is idempotent —
a second run prints nothing and exits 0, and so does a run against a machine that never had it.

Dropping the files is not the whole job, and the uninstaller does the other half too. Every
config the installer edits is edited back, scoped to a marker or to agentkit ownership, with
the rest of the file left alone:

| File                               | Reverted                                                      |
| ---------------------------------- | ------------------------------------------------------------- |
| `~/.claude/settings.json`          | Hook entries running an agentkit hook script                  |
| `~/.claude/CLAUDE.md`              | `<!-- agentkit:<name>:start/end -->` blocks, and legacy ones  |
| `~/.config/opencode/opencode.json` | Only the `instructions[]` entries pointing at the shared root |
| `$CODEX_HOME/config.toml`          | `developer_instructions`, only when it is the agentkit prompt |
| `$CODEX_HOME/hooks.json`           | Only entries tagged `AGENTKIT_HOOK_TARGET=codex`              |
| `~/.bashrc`                        | The `agentkit session shims` block                            |

Kept on purpose: `~/.config/agentkit/config.yaml` unless you pass `--purge-config`, Codex rules
files the checkout does not ship (a hand-written `default.rules` survives), anything another
toolkit installed alongside agentkit, and any real directory sitting where a link into the
shared root belongs — that is your own fork of a skill, so it is reported rather than deleted.

:::tip[Check for dangling links, not for absence]
`test -e` reports a symlink into a deleted shared root as absent while it is still on disk.
`find ~/.claude ~/.agents ~/.grok -xtype l` is the check that actually proves the job is done.
:::
