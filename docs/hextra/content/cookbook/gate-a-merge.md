---
title: Gate a merge on a review record
weight: 2
---

With the `adversarial-review` kit installed, a merge only passes when a review record exists that is
bound to the exact source head the forge is about to merge.

```sh
./agentkit/install.sh --global --with adversarial-review
```

{{< callout type="info" >}}
**The flag is the whole consent story**

This is the one kit `--all` does not give you and the interactive picker never offers. A literal
`--with adversarial-review` installs `review-police`, `review-gate` and `review-profile`; a run
without it removes them again.
{{< /callout >}}

## 1. See how much review the change earns

```sh
review-profile --repo . --risk standard
```

```json
{
  "schema_version": 1,
  "profile": "balanced",
  "context": {
    "risk": "standard",
    "release": false,
    "user_facing": false,
    "target_policy_authoritative": true,
    "worktree_policy_present": true
  },
  "settings": {
    "primary_review": "nontrivial",
    "specialist_review": "critical",
    "product_review": "triggered",
    "ci_evidence": "reuse",
    "local_checks": "affected",
    "evidence_note": "always",
    "min_reported_severity": "low"
  },
  "required": {
    "primary_review": true,
    "specialist_review": false,
    "product_review": false,
    "rerun_ci": false,
    "full_local_checks": false,
    "evidence_note": true
  }
}
```

This resolves **orchestration effort** — how many review lanes to run. It is not merge authority.
The repository's `.agentkit/review-policy.json`, read from the target commit, decides what actually
passes, and cannot be weakened by config.

Other inputs: `--profile fast|balanced|strict`, `--risk trivial|standard|critical`, `--release`,
`--user-facing`.

## 2. Run the review; the reviewer writes the record

```text
.agentkit/reviews/<source-branch-slug>.json
```

What the record must contain depends on the target:

| Target commit                     | Record                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------- |
| no `.agentkit/review-policy.json` | bootstrap: `head_sha`, `verdict`, `findings`; blocks on `BLOCKER` or `HIGH`      |
| policy present                    | strict `schema_version: 2`, validated by `review-gate` against the policy digest |

The strict record's `context` is pinned to the forge, repository, repository id, change id, source
and target branch, **`source_sha` and `target_sha`**, and a digest of the policy that judged it.
Any drift is a denial.

Policy is read from the exact **target** commit, never the source checkout — otherwise a change
could weaken the rules judging that same change.

{{< callout type="warning" >}}
**Keep the record out of git**

`.gitignore` excludes `.agentkit/reviews/`, and that exclusion is load-bearing. Committing a record
moves `HEAD`, which stales the record against the branch it reviews: the gate then denies the merge
and invites regenerating records to suit — the loop the gate exists to stop.

Durable evidence belongs in a redacted PR/MR comment or a controlled forge artifact.
`~/.agentkit/review-audit.log` is the local record of gate decisions.
{{< /callout >}}

## 3. Merge with the reviewed head, explicitly

One standalone command, carrying the exact head the review covered:

```sh
# GitHub
gh pr merge 42 --squash --match-head-commit <reviewed-sha>

# GitLab — --auto-merge=false is required, not optional
glab mr merge 42 --squash --sha <reviewed-sha> --auto-merge=false
```

The head flag is not decoration. It makes the _forge_ refuse the merge if the branch moves after
the hook checked it.

`--auto-merge=false` is required because current `glab` defaults to deferring the merge while a
pipeline runs, and a deferred merge can land a later head that no review has seen. GitHub
merge-queue targets are refused for the same reason.

## What gets refused

| Attempt                                                | Why                                              |
| ------------------------------------------------------ | ------------------------------------------------ |
| no record for the branch                               | nothing reviewed this change                     |
| record's `head_sha` ≠ the head being merged            | commits landed after the review                  |
| merge without `--match-head-commit` / `--sha`          | the forge cannot re-check the head at merge time |
| `--auto`, `--auto-merge`, merge-when-pipeline-succeeds | deferred merges cannot be review-gated           |
| direct REST or GraphQL merge                           | landing context cannot be bound safely           |
| an MCP merge tool                                      | same                                             |
| compound or wrapped commands                           | same — the gate needs one standalone command     |

Every denial names the retry: the flag to add, or the record to regenerate against the current head.

{{< callout type="info" >}}
**What the gate guarantees**

A _stale_ review is mechanically impossible to merge past. The record itself lives in the repository
and the agent can write it, so the gate is a consistency check rather than an authentication one —
pair it with forge-side required approvals, which are what actually prevent a merge.
{{< /callout >}}

The doctrine behind all of this, including the opt-in advisory lane (`--with advisory-review`):
[Review and the gate](/docs/guide/concepts/review/).
