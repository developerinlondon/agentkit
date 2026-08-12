---
title: Write a taste
weight: 3
---

A taste is the cheapest way to add enforcement: one markdown file, no code, no release.

## The file

```markdown
---
name: terse-merge-requests
category: process
strength: prefer
enforce: advise
provenance: 2026-08-01 · a 400-line MR description nobody read
---

Merge request descriptions state what changed and why, in a few lines. The diff is the detail.

Why: a long description is skimmed, so the one paragraph that mattered is the one that got skipped.

How to apply: lead with the outcome, link the issue, and stop.
```

| Field | Values | Notes |
| --- | --- | --- |
| `name` | kebab-case | the key everything resolves on; the same name at a higher scope wins outright |
| `strength` | `prefer`, `require` | how hard to push when it conflicts with something else |
| `enforce` | `advise`, `check`, `block` | the owner's setting, never a rank a taste earns |
| `category` | free text | grouping only |
| `provenance` | a date and an origin | never a guess |

The body carries the preference, then **Why**, then **How to apply**. The why is what lets an agent
apply it to a case you did not anticipate.

## Where to put it

| You want it | Put it in |
| --- | --- |
| in this repository, for everyone who clones it | `.agentkit/tastes/` |
| on this machine, for every repository | `~/.agentkit/tastes/` |

Precedence is project > project external > user > user external > kit. `external/` is reserved — it
is read by position as the vendored-sources layer, and the lint refuses a taste or category of that
name at the root.

## Making it refuse

A taste at `enforce: block` gains a `rule`, and `taste-police` enforces it. The hook carries no rules
of its own: it reads your files, tests each `rule.match` against the command in process, and refuses
with **that taste's** own `remedy` and its named `override`.

```yaml
enforce: block
rule:
  kind: command-match
  match: "git push --force"
remedy: Push a new commit instead; force-push rewrites history other clones already have.
override: ALLOW_FORCE_PUSH
```

Bounds keep a blocking taste from becoming a denial-of-service on your own shell: `match` is capped
at 200 characters, and only the first 4000 characters of a command are tested. A rule the lint cannot
parse is reported as skipped — never silently ignored, because a session that read enforcement into a
guard that never ran is worse than either verdict.

{{< callout type="warning" >}}
**Never raise `enforce` yourself.** A taste does not earn `block` by being violated. Observed
violations are evidence for a proposal to the owner. Leave a dictated taste at `advise` unless the
owner asked for more.
{{< /callout >}}

## A preference no kind can express

Stays at `enforce: check` — loaded, and re-read immediately before an action it covers. A new rule
kind is a change to agentkit, not something a taste file can invent. That boundary is what keeps the
folder a dictionary of preferences rather than a second programming language.
