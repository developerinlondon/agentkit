---
title: Upgrading and removing
weight: 6
---

Re-running the installer _is_ the upgrade. There is no version file, no install manifest and no
timestamp. The state it leaves behind is the remembered kit selection, your seeded config file, and
the marker blocks it writes into files you also own.

## What a second run does

| Class                                    | On re-run                                |
| ---------------------------------------- | ---------------------------------------- |
| skills, rules, tools, hooks, plugins     | overwritten unconditionally              |
| shell profile, client configs            | marker-guarded, never duplicated         |
| `~/.config/agentkit/config.yaml`         | preserved — seeded once, then left alone |
| artifacts unsupported on this platform   | actively removed                         |
| artifacts of any unselected optional kit | actively removed                         |

{{< callout type="warning" >}}
**Local edits inside an installed skill are destroyed on upgrade.** An existing skill directory is
removed and re-copied. Edit the clone, not the install.
{{< /callout >}}

Upgrading also adds any newly shipped core artifacts. Most recently: the `editor-police` commit gate
(inert until `config.yaml` lists repos under `editor-police.repos`; see `config.example.yaml`), the
`wiki-editor` tool and skill it relies on, the `prose-police` write hook
(on by default — it blocks AI writing tells in added markdown/text prose), the `writing-discipline`
rule, and the `humanize` skill. Your preserved `config.yaml` is not rewritten, so it will not gain
the new `prose-police:` section; the hook's defaults apply until you add one. Turn the hook off with
`AGENTKIT_SKIP_HOOKS=prose-police`, per repo with `git config agentkit.prosepolice.enabled false`,
or add the section from `config.example.yaml` with `enabled: false`.

Config files carrying your own content are guarded by markers, so re-runs do not duplicate blocks.
In `CLAUDE.md` those markers look like `<!-- agentkit:<name>:start -->` /
`<!-- agentkit:<name>:end -->`; removal strips exactly that span. Blocks that older versions appended
without markers are still found by their heading and removed.

Observed on a second bare `--global` over the same install: exit 0, **29** `Updating:` lines and
**0** `Installing:` lines, `[config] Existing config preserved`, and still exactly 5 marker blocks in
`CLAUDE.md` and 5 entries in the OpenCode `instructions[]` array rather than 10.

## Removing one kit

`--without <kit>` drops a kit from the selection and remembered set, then removes that kit's managed
artifacts:

| Kit                                                     | `install.sh --global --without <kit>`                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `adversarial-review`, `advisory-review`                 | removes managed instructions, skills, hooks, tools, prompts, and plugins |
| `brain`, `product`, `clickup`, `workspace`, `marketing` | removes managed skills, hooks, settings entries, prompts, and plugins    |

Real directories and plugins that agentkit does not own remain untouched. A real directory using the
same name as an agentkit skill is **reported instead of deleted** — that is your own fork of a skill.

## Removing all of it

```sh
./install.sh --global --uninstall                  # undo a global install
./install.sh --uninstall ~/code/my-project         # undo a project install
./install.sh --global --uninstall --purge-config   # ...and drop config.yaml too
```

Run it from a checkout of the repo that installed it: artifacts are removed by the names that
checkout ships and by symlinks pointing into `~/.agentkit`, never by pattern. It is idempotent — a
second run prints nothing and exits 0, and so does a run against a machine that never had it.

Dropping the files is not the whole job. Every config the installer edits is edited back, scoped to a
marker or to agentkit ownership, with the rest of the file left alone:

| File                               | Reverted                                                      |
| ---------------------------------- | ------------------------------------------------------------- |
| `~/.claude/settings.json`          | hook entries running an agentkit hook script                  |
| `~/.claude/CLAUDE.md`              | `<!-- agentkit:<name>:start/end -->` blocks, and legacy ones  |
| `~/.config/opencode/opencode.json` | only the `instructions[]` entries pointing at the shared root |
| `$CODEX_HOME/config.toml`          | `developer_instructions`, only when it is the agentkit prompt |
| `$CODEX_HOME/hooks.json`           | only entries tagged `AGENTKIT_HOOK_TARGET=codex`              |
| `~/.bashrc`                        | the `agentkit session shims` block                            |

Kept on purpose: `~/.config/agentkit/config.yaml` unless you pass `--purge-config`, Codex rules files
the checkout does not ship, anything another toolkit installed alongside agentkit, and any real
directory sitting where a link into the shared root belongs.

{{< callout type="info" >}}
**Check for dangling links, not for absence.** `test -e` reports a symlink into a deleted shared
root as absent while it is still on disk. The check that actually proves the job is done:

```sh
find ~/.claude ~/.agents ~/.grok -xtype l
```

{{< /callout >}}
