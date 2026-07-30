---
title: Skill groups
description: How skills are partitioned into core, product and strict-review, and exactly when the installer asks.
sidebar:
  order: 2
---

Skills are partitioned by a plain-text manifest, `skills/GROUPS`. A skill with no record belongs
to `core`, which always installs. Adding a group is a manifest entry — the installer, the Claude
plugin generator and the tests all read that one file rather than hard-coding names.

Three groups are declared today.

| Group           | Skills | Selection                                            |
| --------------- | ------ | ---------------------------------------------------- |
| `core`          | 13     | always installed; cannot be deselected               |
| `product`       | 2      | opt-in — the wizard offers it, `--all` includes it   |
| `strict-review` | 1      | **explicit** — only a literal `--with strict-review` |

`product` is `product-intelligence` and `product-review`. `strict-review` is `adversarial-review`,
plus the merge gate's hooks, tools and the `evidence-gated-review` instruction file.

```sh
./agentkit/install.sh --global                        # core only, or last time's answer
./agentkit/install.sh --global --with product         # core + the product group
./agentkit/install.sh --global --all                  # every non-explicit group
./agentkit/install.sh --global --with strict-review   # the only way to get the gate
```

`--with review` is still accepted as an alias for `strict-review`, and prints a one-line notice
saying so.

## Explicit groups are consent-gated

A group marked `explicit` in the manifest behaves differently from a merely optional one, and the
difference is the whole point:

- The interactive wizard never offers it. A `y` at a prompt is too easy to give without reading
  what it wires in.
- `--all` does not include it.
- When it is **not** selected, the installer **removes** its previously installed skills, hooks,
  tools and prompt wiring.

That last rule is deliberate: presence without recorded selection is not consent. Finding the
merge gate on disk is not evidence that anybody chose to be gated.

:::caution
The review machinery is opt-in. Neither `--all` nor the picker installs it. If you want the merge
gate, you have to type `--with strict-review`.
:::

## What a global install remembers

A global install records the chosen groups in `~/.agentkit/groups`, so a later bare
`install.sh --global` upgrades the same set with no flags to re-pass. `--with` adds to that set
rather than replacing it; `--without <group>` drops one.

Deleting a line stops the group being **selected**. For a normal optional group it never deletes
files already on disk — an already-installed skill from an unselected group is still refreshed,
and the installer says so. (An explicit group is the exception above: deselecting it removes its
artifacts.)

An unknown group name left in that file is reported on stderr and ignored, not taken as a
selection.

Project installs take groups per invocation and persist nothing.

## When it asks, and when it stays quiet

On a global install with a real terminal and no remembered answer, the installer asks once per
optional non-explicit group. The question goes to `/dev/tty`, never to stdout, so it cannot
corrupt a piped log.

```text
[groups] Optional skill groups — core installs either way.
[groups]   product: Product-model skills: evidence-backed briefs and product review
[groups]   Install product? [y/N]
```

The default is **decline**. Only `y`, `Y` or `yes` in any casing accept; a bare Enter, an `n`,
garbage, or a failed read all decline and the install continues.

Every guard fails towards silence. The wizard does not run when any of these holds:

| Condition                                                 | Why                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| not `--global`                                            | Project installs persist nothing, so the answer could not be kept and every run would ask. |
| stdin **or** stdout not a tty                             | Output routed into a pipe or a log means an operator who cannot see the question.          |
| `CI` or `AGENTKIT_SKIP_PROMPT` set to any non-empty value | A pty is not evidence of a person — Docker and Jenkins hand out ptys.                      |
| `--no-prompt` or `--all`                                  | An explicit instruction about groups, so there is nothing left to ask.                     |
| any `--with` / `--without`                                | You already answered on the command line.                                                  |
| `~/.agentkit/groups` exists                               | The question was already put. An **empty** file counts as the recorded answer "core only". |

If the guards pass but `/dev/tty` cannot be opened, the installer says so on stderr and installs
core:

```text
[groups] No controlling terminal — installing core only.
[groups] Use --with <group> to add an optional group.
```

An unanswered question does not degrade to a decline — it stops the install until something kills
it. That is why every condition above resolves towards not asking.

## Manifest validation

The installer validates `skills/GROUPS` before it writes anything. Each of these aborts the run:

- a membership line with no group name (it would silently fall through to `core` and ship that
  skill to everyone)
- a skill named in two groups (the bash reader takes the first match, the TypeScript reader takes
  the last — the two would ship different sets)
- an `explicit` marker for a group that was never declared
- a membership naming a group that was never declared (that skill would be uninstallable by any
  flag)

CRLF line endings are rejected loudly by the bash reader. Keep the file LF.

What a skill actually is, and why one can never do a hook's job:
[Skills](/docs/concepts/skills/).
