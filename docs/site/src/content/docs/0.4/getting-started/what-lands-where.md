---
title: What lands where
description: Per-client destinations, symlink versus copy, the configs the
  installer edits, and how a project install differs from a global one.
sidebar:
  order: 3
slug: 0.4/getting-started/what-lands-where
---

One canonical copy under `AGENTKIT_HOME` (default `~/.agentkit`), then per-name links into the
three clients that support them and real copies for the rest. Either way nothing sweeps a client
directory, so skills from other sources — OMC skills under `~/.claude/skills/`, Grok builtins
under `~/.grok/skills/` — sit untouched alongside.

## Per client

| Client           | Destination                        | Form              | Config it edits                                                                 |
| ---------------- | ---------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| OpenCode         | `~/.agents/`                       | symlinks to canon | Instruction paths appended to the `instructions[]` array, deduped               |
| OpenCode plugins | `~/.config/opencode/plugins/`      | real file copies  | —                                                                               |
| Claude Code      | `~/.claude/`                       | symlinks to canon | The `hooks` object in `settings.json`; marker-delimited blocks in `CLAUDE.md`   |
| Grok CLI         | `~/.grok/`                         | symlinks to canon | None — instructions land in the rules directory, which loads always-on          |
| Codex CLI        | `$CODEX_HOME` (default `~/.codex`) | real copies       | `developer_instructions` in `config.toml`; `PreToolUse` entries in `hooks.json` |
| PATH tools       | `~/.local/bin/`                    | real copies       | —                                                                               |

Two placement details matter in practice.

**Codex gets each skill as a prompt file with the YAML frontmatter stripped**, because Codex loads
prompts rather than skill folders.

**The Claude `settings.json` merge overlays the whole `hooks` object.** Pre-existing non-agentkit
entries under the four events the kit defines — `PreToolUse`, `PostToolUse`, `Notification` and
`Stop` — are replaced rather than merged alongside. Entries under any other event survive.

## What is a symlink and what is a copy

Skills, rules and instructions are symlinked per name into OpenCode, Claude Code and Grok, so
editing the canonical file under `~/.agentkit` reaches those clients immediately.

Codex prompts, the OpenCode TypeScript plugins and the executables on `~/.local/bin` are real
copies. They change only on the next install run.

`~/.claude/tools/` is a set of links into `~/.agentkit/tools/`, while `~/.local/bin` keeps real
files so `PATH` resolution works normally.

## Session scoping (Linux only)

On Linux, unless `--no-session-scope` is passed, a global install also:

- places per-session shims that run each agent CLI in its own systemd scope
- writes a systemd **user** slice unit, `agent-sessions.slice`
- appends a marked `PATH` block to `~/.bashrc` **specifically**

No other shell profile is touched, so zsh and fish users add the shim directory themselves. A
runtime only gets a shim when its real binary resolves on a `PATH` with the shim directory removed.

Operator overrides for the slice belong in `agent-sessions.slice.d/` drop-ins, which systemd
layers on top and a re-install will not clobber.

:::caution[The slice the installer writes is not the slice `bounded-run` needs]
`install.sh` provisions the **session** slice, `agent-sessions.slice`. The **work** slice that
`bounded-run` verifies before running a heavy command — `agent-work.slice` — is host-provisioned
separately. The installer never creates it, and `bounded-run` fails closed without it.
:::

## Global versus project

Passing a directory instead of `--global` writes into that project. The two modes are not the
same install with a different prefix.

|                                 | Global                                            | Project                              |
| ------------------------------- | ------------------------------------------------- | ------------------------------------ |
| Skills                          | one copy in canon, linked out                     | two real copies, one per client dir  |
| Rules                           | canon plus links to three clients                 | the OpenCode rules directory only    |
| Instructions and global prompts | installed and wired into all four clients         | **not installed at all**             |
| Codex                           | rules, skill prompts, review hooks, config wiring | review hooks, `hooks.json`, rules    |
| Tools                           | `~/.local/bin`, canon, and Claude links           | the project's Claude tools directory |
| Group memory                    | `~/.agentkit/groups`                              | never written                        |
| Wizard                          | possible                                          | never                                |
| Session shims and slice         | yes, on Linux                                     | never                                |
| `--claude-plugin`               | allowed                                           | rejected, exit 1                     |

Project mode pins one repository to the kit's behaviour without touching the machine. Global mode
is the normal one.
