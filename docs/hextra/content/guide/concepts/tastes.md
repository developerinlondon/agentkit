---
title: Tastes
weight: 3
---

A police unit encodes discipline that is true for everyone. A **taste** encodes a preference that is
true for _you_ — one convention, in one file, that outlives the session it was stated in.

The mechanism is the interesting part: `taste-police` carries **no rules of its own**. It reads your
taste files, tests each one's `rule.match` against the command in process, and refuses with that
taste's own `remedy` and its own named `override`. Blocking a new preference is a file, never a
release.

## A taste is a markdown file

```markdown
---
name: no-stopgaps
scope: external
category: scope
strength: require
provenance: 2026-07-19 · a half-duplex stopgap shipped alongside a toggle whose server half did not exist
---

Build the correct architecture first — no rush to get things done quickly, every rush to get them
done properly. Do not ship the portable-but-wrong version as a seam.

Why: a stopgap is judged as the product, not as a stage.

How to apply: if a genuine correctness-for-speed trade arises, state it and let the owner decide.
```

| Field        | Holds                                         |
| ------------ | --------------------------------------------- |
| `name`       | the key everything resolves on                |
| `scope`      | the layer this file came from                 |
| `strength`   | `prefer` or `require`                         |
| `enforce`    | `advise`, `check`, or `block`                 |
| `category`   | optional grouping                             |
| `provenance` | a date and where it came from — never a guess |

## Precedence

Tastes are a dictionary keyed by `name`, not a record. The same name at a higher scope **replaces**
the lower one outright; two tastes are never merged into a third nobody wrote.

| Layer            | Path                           | In git                   | Holds                                  |
| ---------------- | ------------------------------ | ------------------------ | -------------------------------------- |
| Project          | `.agentkit/tastes/`            | yes, in every clone      | what is true in this repository        |
| Project external | `.agentkit/tastes/external/`   | yes, a vendored snapshot | a source this repository subscribes to |
| User             | `~/.agentkit/tastes/`          | no, machine-local        | personal ergonomics, every project     |
| User external    | `~/.agentkit/tastes/external/` | no, machine-local        | a source this machine subscribes to    |
| Kit              | `rules/`                       | ships with agentkit      | universal engineering discipline       |

Precedence runs **project > project external > user > user external > kit**. The more specific
location wins, and inside one location the owner's own tastes beat the ones they pulled in.

{{< callout type="info" >}}
`external` is reserved at the root of a tastes tree. A taste or category directory of that name is
refused by the lint, because that path is read by position and would be read as a source.
{{< /callout >}}

## What `enforce` means

`enforce` is the owner's setting, never a rank a taste earns by being violated.

| Level    | Effect                                                                                  |
| -------- | --------------------------------------------------------------------------------------- |
| `advise` | loaded as context; the agent is expected to honour it                                   |
| `check`  | re-read immediately before an action it covers                                          |
| `block`  | `taste-police` refuses a matching command, quoting this taste's `remedy` and `override` |

A preference that no rule kind can express stays at `check`. A new kind is a change to agentkit, not
something a taste file can invent.

Two bounds keep a blocking taste from becoming a denial-of-service on your own shell: `rule.match`
is capped at 200 characters, and only the first 4000 characters of a command are tested.

## Sources

A source is a git repository whose files are tastes. **Where you declare it decides where its
snapshot lands** — that is the whole of the choice:

| Declared in                      | Snapshot lands in                   | Read by                           |
| -------------------------------- | ----------------------------------- | --------------------------------- |
| `~/.config/agentkit/config.yaml` | `~/.agentkit/tastes/external/`      | every repository on this machine  |
| `<repo>/.agentkit/config.yaml`   | `<repo>/.agentkit/tastes/external/` | anyone who clones that repository |

Machine-level when the policy is the owner's rather than any repository's — nothing is copied into
any repository, so nothing can leak into a public one. Repository-level when the policy has to
travel with the clone: a team whose members never configured their machines, a CI runner, an agent
handed a repository and nothing else.

Both may be declared and both apply; the repository's sources resolve above the machine's. Two
stores means two locks, because one file describing both would put a machine-local pin in a
repository's review surface.

```sh
bun <skill-dir>/scripts/sync.ts
```

Sync **lints a source before anything is copied** — a source whose tastes the lint refuses is
reported by name and nothing enters the tree — then snapshots the taste files and rewrites that
store's `tastes.lock`. Files that are not tastes stay upstream: nothing executable ever crosses into
your repository with the words.

{{< callout type="warning" >}}
Vendoring a **private** source into a public repository is refused. `visibility` is required of a
source a repository vendors, because the snapshot is committed there.
{{< /callout >}}

## Learning is explicit

Nothing is learned invisibly. A taste is written only at an explicit correction, and its whole output
is a diff someone can read, reject, or amend. `taste.learning: false` keeps the folder read-only — a
correction is then reported rather than filed, along with what the taste would have said.

Never raise `enforce` automatically. Observed violations are evidence for a proposal to the owner,
not a promotion the agent grants itself.
