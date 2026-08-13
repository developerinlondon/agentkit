---
title: Requirements and platforms
weight: 5
---

## Dependencies

| Dependency | Role | Missing means |
| --- | --- | --- |
| `jq` | registers hooks with Claude Code, wires the OpenCode global prompt, parses every hook payload | **hooks are installed but not registered** — see below |
| `awk`, `cat` | the kit-manifest reader, the Codex prompt writer, the marker rewrite, and the hooks | fails mid-run; neither is probed |
| `git` | required by `bootstrap.sh`; runtime dependency of several hooks and the review gate | bootstrap cannot resolve a release |
| `python3` | runtime dependency of the fail-closed hook supervisor and the merge gate | not checked at install time |
| `bun` | only for skills shipping a `package.json` | a warning naming the skill; install continues |
| `dprint` | runtime dependency of `format-police` | formatting enforcement silently stands down |
| `claude` | only for `--claude-plugin` | that flag cannot be used |

{{< callout type="warning" >}}
**Install `jq` before running the installer.** Observed on a sandboxed install with `jq` removed
from `PATH`: the run exits **0**, links every skill, rule and hook script into place — and then
prints

```text
[claude] WARNING: jq not found. Cannot merge hooks into settings.json.
[opencode] WARNING: jq not found. Cannot wire global prompt into opencode.json.
```

`~/.claude/settings.json` is not created. Every hook script is present under `~/.claude/hooks/`, and
**nothing registers them, so no guard fires.** The closing summary reports `Claude Code: manual`,
which is the line to look for. Install `jq` and re-run.
{{< /callout >}}

`resource-police` needs `jq`, `awk` and `cat` to analyse a command. Without one of them it warns
and **intentionally fails open** — it does not block every heavy command on a broken parser.

## Platform detection

Platform is read from `uname -s` and is one of `linux`, `darwin` or `unknown`. `AGENTKIT_PLATFORM`
overrides it with one of those exact three values; anything else is rejected with an error.

Artifacts declare their own support with a directive in their first 15 lines
(`# agentkit:platforms linux`). No directive means portable. Unsupported artifacts are skipped — and
**removed** if a previous run installed them.

{{< tool-table >}}

### Linux

Everything installs: the bounded runner (`bounded-run`, plus the `agentkit-run` compat symlink), the
session-scoping tool `agent-session`, the Codex resource policy, and the `agent-sessions.slice`
session slice.

`bounded-run` fails closed unless the aggregate `agent-work.slice` matches its expected limits
(default 20G/24G memory high/max, 800% CPU, 1536 tasks; hosts sized differently pin their values in
root-owned `/etc/agentkit/resource-guard.conf`), cgroup v2 is available, and host headroom checks
pass. That slice is host-provisioned — the installer does not create it.

Its profiles are fixed and tested together with the host configuration:

| Profile | Memory high/max | CPU | Tasks | Command timeout |
| --- | --- | --- | --- | --- |
| `canary` | 1G / 2G | 2 | 64 | 60s |
| `default` | 6G / 8G | 2 | 256 | 10m |
| `compile` | 8G / 12G | 4 | 512 | 15m |
| `browser` | 12G / 16G | 4 | 1024 | 20m |

### macOS and elsewhere

Session scoping is skipped with a message. `bounded-run`, its `agentkit-run` alias and the Codex
heavy-command policy are not installed, so cgroup containment stands down.

The protections that do not need cgroups remain active: OpenCode still blocks delegated and
undecidable commands, and the Claude hook does so when `jq`, `awk` and `cat` are present. The
portable Codex review hook still installs when `adversarial-review` is selected.

## Configuration file

The installer seeds `~/.config/agentkit/config.yaml` from `config.example.yaml` on first run, and
never overwrites it afterwards. `XDG_CONFIG_HOME` is respected. Every key is listed in the
[configuration reference](/docs/reference/configuration/).
