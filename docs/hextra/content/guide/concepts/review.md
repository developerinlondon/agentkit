---
title: Review and the gate
weight: 6
---

Two different things share the word "review", and confusing them is the most common way to
mis-describe this kit.

|             | Advisory review                                      | The merge gate                             |
| ----------- | ---------------------------------------------------- | ------------------------------------------ |
| Ships as    | `review-discipline.md`, in the `advisory-review` kit | the `adversarial-review` kit               |
| Installed   | only on `--with advisory-review`                     | only on `--with adversarial-review`        |
| Enforcement | none — advisory                                      | `review-police` refuses the merge command  |
| Requires    | a reviewer that did not author the change            | a validated record bound to the exact head |

They are independent: enable either, both, or neither. **Neither is installed by default.**

{{< callout type="warning" >}}
Both kits are marked `explicit`. Neither is in `--all`, neither is offered by the picker, and only a
literal `--with` installs one. When a run does not select one, the installer **removes** what it
previously installed for it. With neither selected, nothing asks for a review and nothing blocks a
merge — the intended default for a harness whose own instructions already mandate a reviewer pass.
{{< /callout >}}

## The discipline

The maker never grades its own work. Before merging substantive work, one advisory review pass runs
in a context that did not author the change — a reviewer subagent where the harness supports one, a
fresh session otherwise.

Three details do most of the work:

- **Review the committed state**, via `git show` or `git diff <base>...HEAD` — never the working
  tree. A shared checkout can hold abandoned edits that were never proposed.
- **Probe, don't read.** Run the tests, execute the change, try to break it. Where the change adds a
  test or a guard, mutate what it claims to cover and confirm it fails; an assertion that cannot fail
  is not evidence.
- **Findings come back ranked, with a concrete failure scenario each**, and the author fixes them
  rather than arguing them down. After fixes, a delta re-review — full re-reviews are for new scope.

Trivial changes are exempt: typos, labels, comment wording, config value tweaks.

## The gate

With `adversarial-review` installed, a merge is refused unless a review record exists that is bound
to the **exact source head the forge is about to merge**.

```mermaid
flowchart TD
  cmd["agent runs<br/>gh pr merge · glab mr merge"]
  deny["BLOCKED"]
  cmd --> tok["tokenise the command<br/>expand shell forms"]
  tok --> shape{"is this shape bindable?"}
  shape -- "MCP tool · REST/GraphQL · auto-merge<br/>wrapped, chained or globbed" --> deny
  shape -- "one standalone forge CLI merge" --> head["resolve the head<br/>from the forge, not the record"]
  head --> pre{"command carries that exact head?"}
  pre -- "missing or different" --> deny
  pre -- "matches" --> pol["read policy from the TARGET commit<br/>never the proposed source"]
  pol --> val["validate the record<br/>schema · bindings · tier · lanes"]
  val --> verdict["derive the verdict<br/>a stored verdict that disagrees is a denial"]
  verdict -- "bindings match, no blockers" --> allow["merge proceeds"]
  verdict -- "anything unresolved or unreadable" --> deny
```

Two properties of that flow are the whole design:

**The change never chooses its own judge.** Policy is read from the exact target commit. A branch
cannot weaken the rules that judge it. If the target commit or its policy state cannot be read, the
answer is deny — _unavailable is not absent_.

**Disagreement is a denial.** The gate derives the verdict itself from the record's contents and
rejects a stored verdict that contradicts it.

### What the record has to carry

Nine `context` fields are each required, type-checked, and compared against what the gate derives:
`forge`, `repository`, `repository_id`, `change_id`, `source_branch`, `target_branch`, `source_sha`,
`target_sha`, and `policy_digest`. On top of that:

| Block          | Contents                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `lanes`        | a diff lane and a product lane, each with a verdict; the product lane also carries coverage                        |
| `findings`     | lane, severity, summary, scenario, resolved — any unresolved blocker or high finding derives a blocked verdict     |
| `claims`       | each verified with evidence, or unverified with a reason; a tier may forbid unverified claims entirely             |
| `checks`       | command plus outcome: passed at exit zero, failed with the code and reason, or **not run** with a reason           |
| `analyses`     | seven closed kinds, from claims audit to artifact lifetime                                                         |
| `user_consent` | an explicit local override carrying a non-blank user quote and a timestamp — a _passing_ record must not carry one |

{{< callout type="info" >}}
The `checks` block having **three** outcomes rather than two is deliberate. A check that shells out
to an external tool can run and pass, run and fail, or **never run** — and the third is the dangerous
one, because a skip reads like a pass in a column of green.
{{< /callout >}}

### Where the artifacts live

| Artifact            | Location                                      | Durable         |
| ------------------- | --------------------------------------------- | --------------- |
| Target-owned policy | `.agentkit/review-policy.json`                | committed       |
| Product contract    | `.agentkit/product.yaml`                      | committed       |
| Local review index  | `.agentkit/reviews/<source-branch-slug>.json` | no — gitignored |
| Evidence packet     | a redacted PR or MR comment                   | yes             |
| Local gate audit    | `~/.agentkit/review-audit.log`                | machine-local   |

The review record must never be committed: committing it changes the source SHA and immediately
makes its own binding stale.

### What the merge command itself must look like

The hook is as strict about the command as about the record, because a command it cannot parse is a
command it cannot bind. Refused outright, before any record is looked for:

- **A merge through an MCP tool.** There is no shell command to inspect.
- **A direct REST or GraphQL merge.** The endpoint carries its own repository identity, which may
  differ from the checkout.
- **A merge-on-pipeline push option**, and any `--auto`, `--auto-merge` or
  `--merge-when-pipeline-succeeds` flag. A deferred merge lands a head no review has seen.
- **Anything but one literal, top-level forge invocation.** The accepted shape is exactly
  `gh pr merge <id>` or `glab mr merge <id>`, flags after the numeric id. Newlines, `$`, backticks,
  shell operators, globs, a second `merge` token, a repeated `--repo` or head flag, or `--host` all
  refuse.

Two positive requirements are easy to miss:

- The command must carry the **exact reviewed head** as a precondition — `--match-head-commit` on
  `gh`, `--sha` on `glab`. Missing counts the same as wrong. This makes the forge itself enforce the
  reviewed SHA.
- On `glab` the command must **explicitly** pass `--auto-merge=false`, because current `glab`
  otherwise defers the merge while a pipeline runs.

A GitHub target requiring the merge queue is refused too: the CLI merge is deferred there, so
protected merge-queue CI is the authoritative gate.

It over-blocks on purpose. A compound command that merely mentions a merge is refused — a false
denial is an inconvenience, and a missed merge is the failure the gate exists to prevent.

## Profiles decide effort, not authority

`review-profile` resolves how much review a change needs: `fast`, `balanced` (the default) or
`strict`.

The resolver is orchestration guidance. It **cannot** lower what the exact target commit's policy
requires. The same asymmetry applies to the config file: a repository's `.agentkit/review-policy.json`
can require stricter evidence and cannot be weakened by `~/.config/agentkit/config.yaml`.

## What the gate proves

It proves **binding**, not authentication. See [boundaries](/guide/concepts/boundaries/#what-the-merge-gate-proves)
for exactly what that excludes.
