---
title: Skills
weight: 7
---

A skill is a `SKILL.md` the agent loads on demand, plus whatever scripts and reference files it needs
to do the job for real. Some are pure playbooks. Others ship working code, and the playbook exists to
say when to run it and what to refuse.

The kit ships **{{< count skills >}} skills**, {{< count coreSkills >}} of them in `core`. One format
serves every harness: the same `SKILL.md` loads through the file installer, the Claude Code plugin,
or a plain symlink.

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

## The catalogue

{{< skill-table >}}

Kit membership is declared in one manifest, `skills/KITS`, read by a shared library so the installer
and the plugin generator can never disagree. See [skill kits](/docs/kits/) for selecting them.

## Skills that ship code

Where a skill directory carries a `package.json`, the installer runs `bun install` in it, and its
build script when it has one — bun does not auto-install merely because a manifest is present.
Without a usable `bun` it warns and continues, which means the skill's scripts are there and its
dependencies are not.

{{< callout type="warning" >}}
An existing skill directory is removed and re-copied on upgrade. **Local edits inside an installed
skill are destroyed.** Edit the clone, not the install.
{{< /callout >}}

## What a skill is allowed to claim

Two conventions run through the catalogue and are worth reading as design rules rather than
formatting.

**Refusals are features.** `product-review` stops when the product manifest is absent rather than
inferring a build from the file tree. `product-intelligence` refuses to write when the acquired
evidence is thin. `adversarial-review` permits finding nothing and names manufacturing findings as a
failure mode.

**A skill states its own limits.** `adversarial-review` and `autonomous-workflow` both say plainly
that a local review record does not authenticate reviewer identity or prove any command ran. A skill
that overclaims about itself is the one you cannot calibrate against.

Several skills are tied to a specific forge or platform — the list is in
[boundaries](/docs/guide/concepts/boundaries/#several-skills-are-not-forge-neutral).
