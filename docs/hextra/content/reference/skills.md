---
title: Skill catalogue
weight: 5
---

{{< count skills >}} skills ship across {{< count kits >}} kits. This table is generated from each
skill's own `SKILL.md` frontmatter and from `skills/KITS`, so a skill cannot appear here with a
description it does not carry, or in a kit it does not belong to.

{{< skill-table >}}

## Kits

{{< kit-table >}}

A skill with no record in `skills/KITS` belongs to `core`, and a skill may name only one kit.
`explicit` kits are never offered by the interactive picker and are excluded from `--all`; only a
literal `--with <kit>` selects one. See [skill kits](/docs/guide/start/kits/).

## Not forge-neutral

The kit is generic about discipline and specific about tooling:

| Skill                     | Actually requires                                       |
| ------------------------- | ------------------------------------------------------- |
| `issue-raiser`            | **GitLab only** — every forge command is `glab`         |
| `gitlab-issue-lifecycle`  | GitLab work items and merge requests                    |
| `github-issue-lifecycle`  | GitHub issues and Projects v2                           |
| `clickup-task-lifecycle`  | ClickUp, and repo-local `agentkit.clickup.*` git config |
| `gitops-master`           | ArgoCD **and** Kargo                                    |
| `resource-safe-execution` | Linux, systemd user scopes, cgroup v2                   |

## Skills that ship code

Where a skill directory carries a `package.json`, the installer runs `bun install` in it, and its
build script when it has one. Without a usable `bun` it warns and continues — the skill's scripts are
there and its dependencies are not. `AGENTKIT_SKIP_SKILL_DEPS` skips the step deliberately.
