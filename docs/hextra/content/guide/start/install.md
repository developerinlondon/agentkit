---
title: Install
weight: 1
---

agentkit installs one canonical copy of its skills, rules, instructions, hooks and tools under
`~/.agentkit`, then links or copies that copy per client. Skills and rules are symlinked into
OpenCode, Claude Code and Grok, so edits to the canon reach them directly. Codex, the OpenCode
plugins and the executables on your `PATH` get real copies, refreshed on the next install run rather
than immediately.

## Pick a door

| Door                    | Installs                                              | Choose it when                                   |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| **Bootstrap one-liner** | everything, from the newest release tag               | you want the normal install and trust the source |
| **Clone first**         | everything, from whatever you cloned                  | you want to read the scripts before running them |
| **Claude plugin**       | hooks, skills, tools, MCP — no always-on instructions | Claude Code is your only harness                 |
| **Skills only**         | `SKILL.md` files and nothing else                     | you want the playbooks without any enforcement   |

{{< tabs >}}

{{< tab name="One line" >}}
Clones to `~/.agentkit-src` (override with `AGENTKIT_SRC`) and runs the global install. Re-running
updates in place.

```sh
curl -fsSL https://raw.githubusercontent.com/developerinlondon/agentkit/main/bootstrap.sh | bash
# with options:  … | bash -s -- --with product
```

**This installs the newest release tag, not `main`.** The bootstrap script itself is read from
`main` — it is a single file, so a truncated download is a syntax error rather than a partial
install — but the kit it installs is the latest `vX.Y.Z`. It prints which release it resolved:

```text
[bootstrap] Latest release: v0.7.13
```

`AGENTKIT_REF` overrides that:

```sh
AGENTKIT_REF=main    curl -fsSL …/bootstrap.sh | bash   # unreleased, bleeding edge
AGENTKIT_REF=v0.7.12 curl -fsSL …/bootstrap.sh | bash   # pin an older release
```

An origin with no `vX.Y.Z` tag stops the install rather than quietly falling back to `main`.

Piped stdin is not a terminal, so the optional-kit question never fires on this path — it installs
`core` only unless you pass `--with <kit>`.

If `~/.agentkit-src` already exists with local changes, bootstrap refuses rather than resetting over
them. When it is clean, a re-run moves it to the newly resolved ref.
{{< /tab >}}

{{< tab name="Clone first" >}}
Read what you are installing before you run it.

```sh
git clone git@github.com:developerinlondon/agentkit.git
./agentkit/install.sh --global
```

The interactive kit picker only appears here, and only on a terminal — see
[skill kits](/kits/).
{{< /tab >}}

{{< tab name="Claude plugin" >}}
Claude Code can take the kit as a plugin marketplace instead of a file install. The two modes are
mutually exclusive: plugin `hooks.json` layered on top of `settings.json` hooks would fire every
hook twice.

```sh
claude plugin marketplace add developerinlondon/agentkit
claude plugin install agentkit                      # hooks, core skills, tools, MCP
claude plugin install agentkit-product              # the opt-in product kit
claude plugin install agentkit-adversarial-review   # the explicit adversarial-review kit
```

The marketplace also carries `assay` and `infra-tools`, which are separate MCP toolchains rather
than skill kits.

`marketplace add` clones over SSH (`git@github.com:developerinlondon/agentkit.git`), so it needs
working GitHub SSH access — not just network. Bare plugin names resolve across your added
marketplaces; use `agentkit@agentkit` if a name is ambiguous.

To wire Claude this way as part of a normal install, pass `--claude-plugin` (global only).

{{< callout type="info" >}}
The plugin format has no way to inject always-on global context, so
[instructions](/guide/concepts/context/) do not arrive on this path. They come from a file install.
{{< /callout >}}
{{< /tab >}}

{{< tab name="Skills only" >}}
The lightest door installs only the `SKILL.md` files, through the community skills CLI, for
harnesses that read skills but not the rest.

```sh
npx skills add developerinlondon/agentkit
```

It installs **no enforcement**: no hooks, no rules, no policies, no tools. This is the "I only want
the playbooks" path.

{{< callout type="warning" >}}
**Run this line yourself, before the install.** agentkit's own `pkg-police` refuses
package-manager commands that disagree with the manager this project's lockfile names — including
`bun install` in an `npm` project. It is not "bun only": with no lockfile, or several that disagree,
nothing is blocked. `AGENTKIT_ALLOW_PKG=1` is the user-approved override for a single command. An
agent asked to run the line above _after_ the kit is installed will be refused.
{{< /callout >}}
{{< /tab >}}

{{< /tabs >}}

## What the installer accepts

| Flag                 | Effect                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--global`           | Install for every tool and project on this machine. Without it, the installer runs in project mode.                |
| `<target-dir>`       | A bare argument is the project directory for project mode. Defaults to the current directory.                      |
| `--with <kit>`       | Add an optional skill kit. Repeatable. The `--with=<kit>` form also works.                                         |
| `--without <kit>`    | Drop a kit from the selection and from the remembered set. Repeatable. `core` cannot be dropped.                   |
| `--all`              | Select every declared kit _except_ those marked explicit in the manifest.                                          |
| `--no-prompt`        | Never run the kit wizard, even on a terminal.                                                                      |
| `--claude-plugin`    | Global only. Wire Claude Code through the plugin marketplace instead of copying hooks and merging `settings.json`. |
| `--no-session-scope` | Global only. Skip the per-session systemd shims, the slice unit and the shell profile block.                       |
| `-h`, `--help`       | Print usage.                                                                                                       |

Exit codes matter if you script around it:

| Condition                            | Exit |
| ------------------------------------ | ---- |
| `--help`                             | `1`  |
| unknown flag (usage goes to stderr)  | `2`  |
| `--without core`                     | `2`  |
| unknown kit name                     | `1`  |
| `--with` / `--without` with no value | `1`  |
| `--claude-plugin` without `--global` | `1`  |

Environment inputs, rather than flags, are listed in the
[environment reference](/reference/environment/).

## Then prove it took

A file listing tells you files were copied. It does not tell you the behaviour changed, which is the
entire product. Go to [verify the install](/guide/start/verify/) next.
