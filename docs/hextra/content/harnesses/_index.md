---
title: Harnesses
weight: 3
cascade:
  type: docs
---

agentkit installs into four coding harnesses from one canonical copy, so the same discipline
applies whichever one you happen to be driving. Coverage is deliberately uneven: a harness gets a
guard only where its extension mechanism can express the check.

## The four

| Harness         | Skills and rules                              | Enforcement mechanism                                        |
| --------------- | --------------------------------------------- | ------------------------------------------------------------ |
| **Claude Code** | symlinked from `~/.agentkit` into `~/.claude` | hook scripts, registered in `settings.json`                  |
| **Grok CLI**    | symlinked into `~/.grok`                      | the same hook scripts, through its Claude-compatibility path |
| **OpenCode**    | symlinked into `~/.agents`                    | TypeScript plugins, copied and refreshed on install          |
| **Codex CLI**   | prompts copied into `~/.codex`                | exec policies matching literal argv prefixes                 |

Skills and rules are **symlinks** to the canon, so editing one file reaches every harness that
links it. Codex prompts, the OpenCode plugins and the executables on your `PATH` are real copies,
refreshed on the next install run. Nothing sweeps a client directory — skills you installed from
anywhere else sit untouched alongside.

## What each unit reaches

Every police unit declares which mechanisms it can be expressed in. A blank cell is not an
oversight; it means that harness cannot see the thing the unit checks.

{{< unit-table >}}

## Where the guards land

Hook units bind to a harness event and a tool matcher, with a timeout. A unit that overruns its
timeout is treated as a refusal only where a fail-closed budget is declared.

{{< wiring-table >}}

{{< callout type="warning" >}}
**Codex reads argv, not shell.** Its policies match literal command prefixes rather than parsing a
shell payload, so the same intent written a different way — through a pipe, a script, an API call —
is outside what they match. [Boundaries](/docs/guide/concepts/boundaries/) states every such limit
in one place.
{{< /callout >}}

## Platform differences

The cgroup tooling is Linux-only. On macOS and elsewhere the bounded runner, its `agentkit-run`
alias and the Codex heavy-command policy are not installed, and containment stands down — while
every guard that does not need cgroups stays active. [Requirements and platforms](/docs/guide/start/requirements/) lists exactly what is skipped and what remains.
