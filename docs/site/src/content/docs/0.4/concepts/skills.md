---
title: Skills
description: What a skill is, how install groups gate them, and why a skill can
  never do a hook's job.
sidebar:
  order: 3
slug: 0.4/concepts/skills
---

A skill is a `SKILL.md` the agent loads on demand, plus whatever scripts and reference files it
needs to do the job for real. Some are pure playbooks. Others ship working code, and the playbook
exists to say when to run it and what to refuse.

The kit ships **16 skills**, catalogued one by one in the [skills reference](/docs/0.4/reference/skills/).
One format serves every harness: the same `SKILL.md` loads through the file installer, the Claude Code
plugin, or a plain symlink.

## Skills versus hooks

They are not two flavours of the same thing. They fail in opposite directions.

|                    | Skill                          | Police hook                          |
| ------------------ | ------------------------------ | ------------------------------------ |
| Activation         | the agent decides to load it   | the harness runs it, unconditionally |
| Effect             | instructions in context        | refuses the tool call                |
| Failure mode       | never loaded — nothing happens | crashes — reads as approval          |
| Can be argued with | yes                            | no                                   |
| Scope              | whatever the text covers       | one tool call                        |

A skill can carry judgement a hook cannot express: _when_ mutation testing is worth it, _which_
subtree to scope a diagram to, _whether_ this change needs a specialist reviewer. A hook can carry
force a skill cannot: the unbounded build simply does not run.

Where the two overlap they are wired to agree. `resource-safe-execution` explains which
`bounded-run` profile fits a workload; `resource-police` refuses the unbounded form. Neither is
sufficient alone — the skill has no teeth, the hook has no idea which profile you wanted.

## Install groups

Group membership is declared in one manifest, `skills/GROUPS`, read by a shared library so the
installer and the plugin generator can never disagree. [Skill groups](/docs/0.4/getting-started/skill-groups/)
covers selecting them at install time. A skill with no record belongs to `core`, and
a skill may name only one group.

| Group           | Skills                                   | Installs                                  |
| --------------- | ---------------------------------------- | ----------------------------------------- |
| `core`          | 13                                       | always                                    |
| `product`       | `product-intelligence`, `product-review` | `--with product`, the picker, or `--all`  |
| `strict-review` | `adversarial-review`                     | **only** a literal `--with strict-review` |

:::caution[`strict-review` is explicit opt-in, and deselection removes it]
`strict-review` is marked `explicit` in the manifest. It is never offered by the interactive picker
and is **excluded from `--all`**. Only a literal `--with strict-review` selects it — `--with review`
survives as an alias.

When it is not selected, the installer does not merely skip it: it **removes** the previously
installed hooks, tools, skills, and prompt wiring. Presence without recorded selection is not
consent for a consent-gated group.
:::

The manifest validator catches the typos nothing else can: a membership line that lost its group
name (which would fall through to `core` and ship that skill to everyone), two memberships for one
skill (the bash and TypeScript readers resolve first-match and last-match respectively, so the two
would ship different sets), and an `explicit` marker or membership naming an undeclared group.

## Skills that ship code

Where a skill directory carries a `package.json`, the installer runs `bun install` in it, and its
build script when it has one — bun does not auto-install merely because a manifest is present.
Without a usable `bun` it warns and continues, which means the skill's scripts are there and its
dependencies are not.

## Several skills are not forge-neutral

The kit is generic about discipline and specific about tooling. Assuming otherwise is how a
playbook silently stops applying:

| Skill                     | Actually requires                               |
| ------------------------- | ----------------------------------------------- |
| `issue-raiser`            | **GitLab only** — every forge command is `glab` |
| `gitlab-issue-lifecycle`  | GitLab work items and merge requests            |
| `github-issue-lifecycle`  | GitHub issues and Projects v2                   |
| `gitops-master`           | ArgoCD **and** Kargo                            |
| `resource-safe-execution` | Linux, systemd user scopes, cgroup v2           |

There is no GitHub counterpart to `issue-raiser`'s research lane. `github-issue-lifecycle` files and
tracks GitHub issues, but nothing in the kit derives root cause and assignees from git history the
way `issue-raiser` does.

## What a skill is allowed to claim

Two conventions run through the catalogue and are worth reading as design rules rather than
formatting.

**Refusals are features.** `product-review` stops when the product manifest is absent rather than
inferring a build from the file tree. `product-intelligence` refuses to write when the acquired
evidence is thin. `adversarial-review` permits finding nothing and names manufacturing findings as
a failure mode.

**A skill states its own limits.** `adversarial-review` and `autonomous-workflow` both say plainly
that a local review record does not authenticate reviewer identity or prove any command ran. A
skill that overclaims about itself is the one you cannot calibrate against.
