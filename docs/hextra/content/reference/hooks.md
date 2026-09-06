---
title: Hooks
weight: 1
---

A police unit is one piece of discipline expressed as a refusal. It inspects a tool call the agent is
about to make, or a file it has just written, and either stays silent or denies with a message naming
the legitimate override.

Every table on this page is generated from the repository at build time. If a unit is added, removed
or rewired and this page is not regenerated, the build fails rather than publishing a table that used
to be true.

## Coverage

Coverage across mechanisms is deliberately uneven. A unit exists in a mechanism only where that
mechanism can express the check: Codex policies match literal argv prefixes, so a check that needs to
read a file's contents cannot live there.

{{< unit-table >}}

The last column is packaging, not a fourth mechanism. `scripts/sync-cc-plugin.sh` copies
`hooks/claude/` into the Claude Code plugins verbatim, so a packaged hook is the same script reaching
you by a different route. A test in this repository fails if the copy ever differs from its source.

Note which plugin packages `review-police`: it ships in `agentkit-adversarial-review`, not in
`agentkit`. The review gate is an opt-in kit, and its absence from the default plugin is what that
means in practice.

## Wiring

The event decides what a unit can still prevent. A `PreToolUse` hook runs _before_ the call and can
refuse it. A `PostToolUse` hook runs _after_ the write has already happened; it reports, and the agent
is expected to fix what it reports.

{{< wiring-table >}}

{{< callout type="warning" >}}
**Exit codes carry the refusal.** A `PostToolUse` refusal is exit `2`; the harness discards the
output of one that exits `0`. Because a missing decision is what allows the call through, a unit that
crashes or loses a dependency reads as approval unless something makes it fail closed.
{{< /callout >}}

The fail-closed budget in the last column is that something. `review-police` runs behind
`fail-closed-hook.sh`, which denies the call if the guard has not answered inside the budget. The
harness timeout sits above the budget on purpose: the wrapper must be the thing that decides, not the
harness giving up.

## What each unit refuses

This column is hand-written, because the refusal wording lives nowhere machine-readable. It names the
refusals you are most likely to meet, **not an exhaustive list** — several units refuse more than is
shown, and the authority is always the implementation. The unit list itself is generated, so a unit
cannot go missing from this table, but a cell can be incomplete.

| Unit                | Refuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coding-police`     | files over the length cap, functions over the length cap, duplicated blocks, too many exports in one file, a directory holding more source files than `max-dir-files`, and, in code and config files only, a `../..` path aimed at one of seven known sibling repositories                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `comment-police`    | a comment block longer than `max-block-lines`, a comment-to-code ratio over the limit, and forge references in source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `format-police`     | a file `dprint` cannot parse. Formatted output is rewritten in place rather than refused, and the check skips with a warning when `dprint` or a `dprint.json` is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `git-police`        | force pushes, `--no-verify`, AI attribution in commits _and_ in forge content, commits and pushes touching a protected branch, branch creation in a shared clone, a branch behind the default branch, a branch cut from another feature branch, stale local branches, and creating a branch while unfinished ones are already open — where finished means the forge says a change from the branch merged, never what git topology says                                                                                                                                                                                                                                                                                                                                                           |
| `issue-police`      | filing an issue whose body does not carry a `Disposition:` line, and one whose line does not name `in-progress`, `owner-deferred`, `owner-request`, or `blocked-by` with non-empty text — `follow-up`, `later`, `tech debt`, and similar labels are refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `kubectl-police`    | `kubectl create` or `kubectl apply` against Kargo custom resources, where the GitOps controller owns the state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `mr-police`         | opening another GitLab merge request while one you authored is already open on the repository                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pages-police`      | a direct write to the Pages API, which would bypass the publish-time figure lint and the canonical git history, and an unapproved `--allow-bare-svg`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `prose-police`      | AI writing tells in the ADDED prose of a markdown or text write, and in the body, description, title, notes, message, and comment text a `gh`/`glab` command carries — inline flags, REST `--field` pairs, or a readable `--body-file` (the Bash arm denies; scanning is scoped to the forge command itself, so a commit message sharing the line is not its business): stock vocabulary (`delve`, `tapestry`, `leverage`), significance inflation (`plays a crucial role`), negative parallelism (`not just X, but Y`), chatbot filler, time-of-day naming that assumes the reader's clock (`morning pass`, `tonight`, `overnight`, `first thing tomorrow`), and em-dash density over the limit. Fenced and inline code are exempt, as are changelogs and the artifacts that teach the patterns |
| `plan-police`       | an edit that marks a plan done while its own gaps section still lists work that is neither ticked, struck through, nor carrying an issue reference. It judges the content the edit is about to land, so an edit that closes the last gap in the same breath passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pkg-police`        | package-management subcommands belonging to a manager the project does not use — inferred from the lockfile, so `bun install` is refused in an `npm` project just as `npm install` is in a bun one. Read-only queries such as `npm ls` pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `resource-police`   | a heavy command not run through the **installed** `bounded-run` — trust is by installed path, not by filename — plus delegated workloads, which `bounded-run` cannot contain at all, and commands whose shell nesting it cannot parse (Linux only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `review-police`     | a forge merge unless review evidence passed for the forge-selected source head and the current target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `taste-police`      | whatever your own tastes say it refuses. It carries no rules of its own: it reads the taste files at `enforce: block`, tests each `rule.match` against the command in process, and refuses with that taste's `remedy` and its named `override`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `wait-police`       | ending the turn while a subagent or a background task is still running and no bounded poll is armed on the artefact. Liveness comes from the session transcript, the only place the harness records it; a poll counts only when its command carries its own deadline, so a bare `--watch` or an uncapped sleep loop does not                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `version-police`    | a dependency pin that lags the upstream latest by a major version; a pin merely behind within its major warns instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `delegation-police` | commands whose work escapes local containment — off-machine delegation such as `ansible`, and privilege wrappers such as `doas`. Read-only diagnostic forms are explicitly allowed, so `kubectl get` and `docker ps` pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Which are off by default

| Unit                | Default                                             | Turned on by                      |
| ------------------- | --------------------------------------------------- | --------------------------------- |
| `resource-police`   | enforces nothing                                    | `resource-police.enabled: true`   |
| `delegation-police` | enforces nothing; its Codex policy is not installed | `delegation-police.enabled: true` |
| `review-police`     | not installed                                       | `--with adversarial-review`       |
| `taste-police`      | installed, but inert without blocking tastes        | a taste at `enforce: block`       |

{{< callout type="warning" >}}
**Keep `jq` and `dprint` on `PATH`.** Each direction of failure is chosen deliberately.
`format-police` skips when `dprint` or a `dprint.json` is absent, so formatting enforcement is off on
a machine without them. Without `jq`, most units allow the call. **`review-police` is the exception
and fails closed**, refusing the merge rather than letting it through.

The convention is fail open for detection and fail closed for the gate. Neither state announces
itself while it is happening, so confirm both dependencies resolve after an install.
{{< /callout >}}

## Turning one off

| Scope       | How                                                                                    |
| ----------- | -------------------------------------------------------------------------------------- |
| one command | the unit's own override variable — see [override a guard](/cookbook/override-a-guard/) |
| one session | `AGENTKIT_SKIP_HOOKS=<unit>,<unit>` or `AGENTKIT_SKIP_HOOKS=all`                       |
| permanently | the unit's key in [`config.yaml`](/reference/configuration/), where it has one         |

`AGENTKIT_SKIP_HOOKS` is honoured by the units whose refusal is advice rather than a gate —
`coding-police`, `comment-police`, `prose-police`, `format-police`, `plan-police` and
`wait-police` on the Claude side, `version-police` on the OpenCode side — and by `issue-police`,
the one blocking exception. The rest of the refusing units do not honour it; most take a
per-command override variable instead.
