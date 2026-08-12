---
title: Write a skill
weight: 2
---

A skill is a directory under `skills/` holding a `SKILL.md`, plus whatever scripts and reference
files it needs. One format serves every harness.

## The frontmatter is the trigger

```markdown
---
name: my-skill
description: >-
  What it does, and — critically — WHEN to reach for it. Triggers: the literal
  phrases a user says when they want this.
---
```

`description` is not a summary for humans. It is the only thing an agent reads when deciding whether
to load the skill, so it must contain the trigger conditions, not just the capability.

The facts generator reads this field to build the [catalogue](/docs/reference/skills/), and it **fails the
build** on a skill with no frontmatter or no description. A block scalar (`>-`) is handled; an empty
value is an error.

## Structure

{{< filetree/container >}}
  {{< filetree/folder name="skills/my-skill" state="open" >}}
    {{< filetree/file name="SKILL.md" >}}
    {{< filetree/folder name="references" >}}
      {{< filetree/file name="format.md" >}}
    {{< /filetree/folder >}}
    {{< filetree/folder name="scripts" >}}
      {{< filetree/file name="sync.ts" >}}
    {{< /filetree/folder >}}
    {{< filetree/file name="package.json" >}}
  {{< /filetree/folder >}}
{{< /filetree/container >}}

Keep `SKILL.md` to what has to be in context to *decide and act*. Detail that is only needed once the
agent has committed belongs in `references/`, which it reads on demand — the same context budget
argument that separates instructions from rules from skills.

A `package.json` makes the installer run `bun install` in the directory, and its build script when it
has one. Without a usable `bun` the install warns and continues, so the scripts land without their
dependencies.

## Two conventions that run through the catalogue

**Refusals are features.** State what the skill will not do and what it does instead. `product-review`
stops when the product manifest is absent rather than inferring a build from the file tree;
`product-intelligence` refuses to write when the evidence is thin.

**A skill states its own limits.** If it needs GitLab, say GitLab — not "your forge". If a record it
writes does not authenticate anything, say so in the skill itself. A skill that overclaims about
itself is the one you cannot calibrate against.

## Put it in a kit

A skill with no record in `skills/KITS` belongs to `core` and installs for everyone. To make it
optional, add a membership line:

```text
kit mykit            What this kit adds, as an installer shows it
my-skill mykit
```

Add `explicit mykit` if it should never be offered by the picker or included in `--all`.

{{< callout type="warning" >}}
Declaring a kit is more than two lines in `KITS`. A kit that installs cleanly also needs its Claude
plugin manifest, its entry in the plugin sync allowlist, and its uninstall path — a missing
membership line silently lands the skill in `core` instead, which ships it to everyone.
{{< /callout >}}

The manifest validator aborts the install before touching a file on a membership line with no kit, a
skill in two kits, or an `explicit` marker naming a kit that was never declared.

## What a skill cannot do

It cannot enforce. The agent decides whether to load it, and a skill that is never loaded does
nothing at all. If the rule must hold, it is a [police unit](/docs/guide/extending/police-unit/) — and the
two are wired to agree where they overlap, the skill carrying the judgement and the hook the force.
