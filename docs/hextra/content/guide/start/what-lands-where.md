---
title: What lands where
weight: 3
---

One canonical copy under `AGENTKIT_HOME` (default `~/.agentkit`), then per-name links into the three
clients that support them and real copies for the rest. Nothing sweeps a client directory, so skills
from other sources — OMC skills under `~/.claude/skills/`, Grok builtins under `~/.grok/skills/` —
sit untouched alongside.

## Per client

| Client | Destination | Form | Config it edits |
| --- | --- | --- | --- |
| OpenCode | `~/.agents/` | symlinks to canon | instruction paths appended to the `instructions[]` array, deduped |
| OpenCode plugins | `~/.config/opencode/plugins/` | real file copies | — |
| Claude Code | `~/.claude/` | symlinks to canon | the `hooks` object in `settings.json`; marker-delimited blocks in `CLAUDE.md` |
| Grok CLI | `~/.grok/` | symlinks to canon | none — instructions land in the rules directory, which loads always-on |
| Codex CLI | `$CODEX_HOME` (default `~/.codex`) | real copies | `developer_instructions` in `config.toml`; `PreToolUse` entries in `hooks.json` |
| PATH tools | `~/.local/bin/` | real copies | — |

{{< filetree/container >}}
  {{< filetree/folder name="~/.agentkit" state="open" >}}
    {{< filetree/folder name="skills" >}}{{< /filetree/folder >}}
    {{< filetree/folder name="rules" >}}{{< /filetree/folder >}}
    {{< filetree/folder name="instructions" >}}{{< /filetree/folder >}}
    {{< filetree/folder name="hooks" >}}
      {{< filetree/folder name="lib" >}}{{< /filetree/folder >}}
    {{< /filetree/folder >}}
    {{< filetree/folder name="tools" >}}{{< /filetree/folder >}}
    {{< filetree/folder name="tastes" >}}{{< /filetree/folder >}}
    {{< filetree/file name="kits" >}}
  {{< /filetree/folder >}}
{{< /filetree/container >}}

Two placement details matter in practice.

**Codex gets each skill as a prompt file with the YAML frontmatter stripped**, because Codex loads
prompts rather than skill folders.

**The Claude `settings.json` merge overlays the whole `hooks` object.** Pre-existing non-agentkit
entries under the events the kit defines are replaced rather than merged alongside. Entries under
any other event survive.

## Symlink or copy

| Form | What | Why |
| --- | --- | --- |
| symlink | skills, rules, instructions → OpenCode, Claude, Grok | editing the canon reaches those clients immediately |
| copy | Codex prompts and policies | Codex loads prompts, not skill folders |
| copy | OpenCode TypeScript plugins | the plugin runtime loads real files from its own directory |
| copy | `~/.local/bin` executables | `PATH` resolution expects files |

Copies change only on the next install run. `~/.claude/tools/` is a set of links into
`~/.agentkit/tools/`, while `~/.local/bin` keeps real files.

## What is in the tree

{{< tabs >}}
  {{< tab name="Rules" >}}
Markdown with a `globs` key in the frontmatter. The client decides how to load them.

{{< context-table kind="rules" >}}
  {{< /tab >}}
  {{< tab name="Instructions" >}}
Always-on global prompts, wired through each client's own mechanism.

{{< context-table kind="instructions" >}}
  {{< /tab >}}
  {{< tab name="Codex policies" >}}
Argv-prefix exec policies. They match literal argument prefixes and do not parse shell payloads.

`{{< count codexPolicies >}}` policy files ship; two of them install only when their unit is
enabled in the configuration.
  {{< /tab >}}
  {{< tab name="OpenCode plugins" >}}
Real TypeScript copies under `~/.config/opencode/plugins/`. `{{< count plugins >}}` ship.
  {{< /tab >}}
{{< /tabs >}}

## Session scoping (Linux only)

On Linux, unless `--no-session-scope` is passed, a global install also:

- places per-session shims that run each agent CLI in its own systemd scope
- writes a systemd **user** slice unit, `agent-sessions.slice`
- appends a marked `PATH` block to `~/.bashrc` **specifically**

No other shell profile is touched, so zsh and fish users add the shim directory themselves. A
runtime only gets a shim when its real binary resolves on a `PATH` with the shim directory removed.

Operator overrides for the slice belong in `agent-sessions.slice.d/` drop-ins, which systemd layers
on top and a re-install will not clobber.

{{< callout type="warning" >}}
**Two slices, two owners.** `install.sh` provisions the **session** slice,
`agent-sessions.slice`. The **work** slice that `bounded-run` verifies before running a heavy
command — `agent-work.slice` — is provisioned on the host separately, and `bounded-run` fails closed
until it is in place. See [containment](/guide/concepts/containment/).
{{< /callout >}}

## Global versus project

Passing a directory instead of `--global` writes into that project. The two modes are not the same
install with a different prefix.

| | Global | Project |
| --- | --- | --- |
| Skills | one copy in canon, linked out | two real copies, one per client dir |
| Rules | canon plus links to three clients | the OpenCode rules directory only |
| Instructions and global prompts | installed and wired into all four clients | **not installed at all** |
| Codex | exec policies, markdown rules, skill prompts, review hooks, `config.toml` wiring | exec policies in `.codex/rules/`; review hooks and `hooks.json` only with `adversarial-review` |
| Tools | `~/.local/bin`, canon, and Claude links | the project's Claude tools directory |
| Kit memory | `~/.agentkit/kits` | never written |
| Wizard | possible | never |
| Session shims and slice | yes, on Linux | never |
| `--claude-plugin` | allowed | rejected, exit 1 |

Project mode pins one repository to the kit's behaviour without touching the machine. Global mode is
the normal one.
