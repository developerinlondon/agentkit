---
title: Requirements and platforms
description: What the installer needs, what degrades to a warning, and which
  protections stand down off Linux.
sidebar:
  order: 5
slug: 0.4/getting-started/requirements
---

The installer validates the group manifest before it writes anything — a membership line with no
group, a skill in two groups, or a group used but never declared each abort the run before any file
is touched.

## Dependencies

| Dependency   | Role                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jq`         | **Effectively mandatory** — see the warning below. A core-only install still exits 0 without it; `--with strict-review` aborts at the Codex review-hook stage.                                         |
| `bun`        | Optional. Only skills shipping a `package.json` need it — a missing bun prints a warning naming the skill and the install continues.                                                                   |
| `python3`    | Runtime dependency of the fail-closed hook supervisor and the merge gate, not checked at install time.                                                                                                 |
| `awk`, `cat` | Required by `install.sh` itself — the group-manifest reader, the Codex prompt writer and the marker rewrite all use them — as well as by the hooks. Neither is probed, so a missing one fails mid-run. |
| `git`        | Required by `bootstrap.sh`; otherwise a runtime dependency of the hooks and the review gate.                                                                                                           |
| `claude`     | Only for `--claude-plugin`.                                                                                                                                                                            |
| `dprint`     | Runtime dependency of `format-police`, which formats files after a write.                                                                                                                              |

:::danger[Without `jq`, a core-only install succeeds and enforces nothing on Claude Code]
Observed on a sandboxed install with `jq` removed from `PATH`: the run exits **0**, links all 13
skills, all 5 rules and all 10 hook scripts into place — and then prints

```text
[claude] WARNING: jq not found. Cannot merge hooks into settings.json.
[opencode] WARNING: jq not found. Cannot wire global prompt into opencode.json.
```

`~/.claude/settings.json` is **never created**. The hook scripts are all present under
`~/.claude/hooks/`, but nothing registers them, so no guard fires. The OpenCode `instructions[]`
wiring is skipped too. The closing summary says `Claude Code: manual` — that line is the only
signal that the install did not finish the job.

Install `jq` and re-run.
:::

`resource-police` needs `jq`, `awk` and `cat` to analyse a command. Without one of them it warns
and **intentionally fails open** — it does not block every heavy command on a broken parser.

## Platform detection

Platform is read from `uname -s` and is one of `linux`, `darwin` or `unknown`. `AGENTKIT_PLATFORM`
overrides it with one of those exact three values; anything else is rejected with an error.

Artifacts declare their own support with a directive in their first 15 lines
(`agentkit:platform linux`, or `agentkit:platforms linux darwin`). No directive means portable.
Unsupported artifacts are skipped — and removed if a previous run installed them.

### Linux

Everything installs: the bounded runner (`bounded-run`, plus the `agentkit-run` compat symlink),
the session-scoping tool `agent-session`, the Codex resource policy, and the `agent-sessions.slice`
session slice.

`bounded-run` fails closed unless the aggregate `agent-work.slice` matches its expected limits
(default 20G/24G memory high/max, 800% CPU, 1536 tasks; hosts sized differently pin their values in
root-owned `/etc/agentkit/resource-guard.conf`), cgroup v2 is available, and host headroom checks
pass. That slice is host-provisioned — the installer does not create it.

Its profiles are fixed and tested together with the host configuration:

| Profile   | Memory high/max | CPU | Tasks | Command timeout |
| --------- | --------------- | --- | ----- | --------------- |
| `canary`  | 1G / 2G         | 2   | 64    | 60s             |
| `default` | 6G / 8G         | 2   | 256   | 10m             |
| `compile` | 8G / 12G        | 4   | 512   | 15m             |
| `browser` | 12G / 16G       | 4   | 1024  | 20m             |

### macOS and elsewhere

Session scoping is skipped with a message. `bounded-run`, its `agentkit-run` alias and the Codex
heavy-command policy are not installed, so cgroup containment stands down.

The protections that do not need cgroups remain active: OpenCode still blocks delegated and
undecidable commands, and the Claude hook does so when `jq`, `awk` and `cat` are present. The
portable Codex review hook still installs when `strict-review` is selected.

## Configuration file

The installer seeds `~/.config/agentkit/config.yaml` from `config.example.yaml` on first run, and
never overwrites it afterwards. `XDG_CONFIG_HOME` is respected.

That file tunes thresholds — `coding-police` file, function, duplicate, export and directory
limits; `comment-police` block, header and ratio limits and its forbidden-pattern regexes;
`git-police` branch-protection exemptions; which package manager `pkg-police` enforces;
`version-police` on/off; and the
default review profile. Repositories may override the `review` section in `.agentkit/config.yaml`.

`AGENTKIT_SKIP_HOOKS` turns hooks off for one session, by comma-separated name or with `all`. Only
some units honour it: `coding-police`, `comment-police` and `format-police` on the Claude side, and
`version-police` on the OpenCode side. The refusing hooks — `git-police`, `pkg-police`,
`resource-police`, `mr-police`, `kubectl-police`, `pages-police`, `review-police` — do not, and use
their own per-command override variables instead.
