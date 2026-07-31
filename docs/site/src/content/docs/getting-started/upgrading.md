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

| Class                                   | On re-run                                |
| --------------------------------------- | ---------------------------------------- |
| skills, rules, tools, hooks, plugins    | overwritten unconditionally              |
| shell profile, client configs           | marker-guarded, never duplicated         |
| `~/.config/agentkit/config.yaml`        | preserved — seeded once, then left alone |
| artifacts unsupported on this platform  | actively removed                         |
| artifacts of an unselected explicit kit | actively removed                         |

:::caution[Local edits inside an installed skill are destroyed on upgrade]
An existing skill directory is removed and re-copied. Edit the clone, not the install.
:::

Two more details:

- **Deselecting an ordinary kit never deletes anything.** An already-installed skill from an
  unselected kit is still refreshed, and the installer says so. Deselection changes what is
  chosen, never what is on disk, so an upgrade never removes a skill you are using.
- **An unselected explicit kit is the exception.** `advisory-review` and `adversarial-review` are
  consent-gated: when one is not selected, its hooks, tools, skills and prompt wiring are removed.
  Presence without recorded selection is not consent. In particular, upgrading from a version where
  `review-discipline.md` was core removes that instruction on the next plain install — pass
  `--with advisory-review` to keep it.

Config files carrying your own content are guarded by markers or predicates, so re-runs do not
duplicate blocks. In `CLAUDE.md` those markers look like
`<!-- agentkit:<name>:start -->` / `<!-- agentkit:<name>:end -->`; removal strips exactly that
span. Blocks that older versions appended without markers are still found by their heading and
removed.

Observed on a second bare `--global` over the same install: exit 0, **29** `Updating:` lines and
**0** `Installing:` lines, `[config] Existing config preserved`, and still exactly 5 marker blocks
in `CLAUDE.md` and 5 entries in the OpenCode `instructions[]` array rather than 10.

## Removing one kit

`--without <kit>` drops a kit from the selection and from the remembered set, but what that
does on disk depends on the kind of kit:

| Kit                                     | `install.sh --global --without <kit>`                                  |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `adversarial-review`, `advisory-review` | Fully removed — skills, hooks, `settings.json` entries, tools, prompts |
| `memory`, `product`                     | De-selected only; installed skills and hooks stay and keep updating    |

That asymmetry is the same rule as above: a consent-gated kit goes when consent is withdrawn,
an ordinary one is never taken out from under someone using it. To get an ordinary kit off a
machine, uninstall and reinstall the set you want — the uninstall clears the remembered
selection along with everything else.

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
