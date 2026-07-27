# Agent review process

`review-police` is a local merge-interception gate. In strict mode it validates
an evidence index for the exact forge change against policy read from the exact
protected target commit.

It is not an authentication boundary. The agent can write local JSON, so the
gate cannot prove reviewer identity, model-family independence, command
execution, redaction, or the truth of an evidence reference. Required forge
checks and approvals remain the authority that can prevent a determined bypass.

```mermaid
flowchart LR
  A[exact forge source and target] --> B[target-commit policy]
  A --> C[commit-bound changed paths]
  B --> D[review-gate]
  C --> D
  E[local v2 evidence index] --> D
  D -->|valid pass| F[CLI merge may run]
  D -->|invalid or blocked| G[explicit deny]
```

## Activation and bootstrap

The source checkout never selects the policy that judges itself.

- Target commit contains `.agentkit/review-policy.json`: strict v2 is mandatory.
- Target commit definitively lacks that path: the bounded legacy v1 adapter is
  used.
- Target commit or policy state cannot be read: deny. Unavailable is not absent.
- A change adding the first policy is reviewed under v1. That policy activates
  only after it lands on the protected target.
- An existing malformed, symlinked, or unsupported target policy denies; it
  never falls back to v1.

The policy itself is always classified critical when changed, even if a proposed
policy removes its own risk zone.

## Artifacts

| Artifact            | Path/location                                 | Durable?       |
| ------------------- | --------------------------------------------- | -------------- |
| Target-owned policy | `.agentkit/review-policy.json`                | committed      |
| Product contract    | `.agentkit/product.yaml`                      | committed      |
| Local review index  | `.agentkit/reviews/<source-branch-slug>.json` | no; gitignored |
| Evidence packet     | redacted PR/MR comment or controlled artifact | yes            |
| Local gate audit    | `~/.agentkit/review-audit.log`                | machine-local  |

The local record points at durable evidence; it is not the evidence archive.
Never commit it: committing changes the source SHA and immediately makes its own
binding stale.

Branch slugs replace `/` with `__`. Context fields inside v2 prevent a colliding
filename from authorising a different repository or change.

## Strict v2 record

```json
{
  "schema_version": 2,
  "context": {
    "forge": "github",
    "repository": "https://github.com/owner/repo",
    "repository_id": "github:github.com:R_example",
    "change_id": 123,
    "source_branch": "feat/example",
    "target_branch": "main",
    "source_sha": "<40-or-64-lower-hex>",
    "target_sha": "<40-or-64-lower-hex>",
    "policy_digest": "<target-policy Git blob OID>"
  },
  "risk": {
    "tier": "critical",
    "rationale": "Touches merge enforcement"
  },
  "lanes": {
    "diff": {
      "verdict": "pass",
      "summary": "Exact source-head diff survived falsification"
    },
    "product": {
      "verdict": "pass",
      "coverage": "partial",
      "summary": "Install and merge-denial paths were exercised"
    }
  },
  "findings": [],
  "claims": [
    {
      "lane": "diff",
      "claim": "Target policy cannot be weakened by the source",
      "status": "verified",
      "evidence": "target-policy integration test"
    }
  ],
  "checks": [
    {
      "id": "tests",
      "command": "scripts/product-command default -- bun test",
      "status": "pass",
      "exit_code": 0,
      "output_summary": "suite passed with no failures"
    }
  ],
  "analyses": [
    {
      "kind": "falsification",
      "status": "verified",
      "summary": "Source-policy substitution was attempted",
      "evidence": "integration test and trace"
    },
    {
      "kind": "artifact_lifetime",
      "status": "not_applicable",
      "reason": "No durable runtime artifact is introduced"
    }
  ],
  "evidence_ref": "https://forge.example/owner/repo/pull/123#evidence",
  "verdict": "pass"
}
```

Closed enums and exact JSON types are enforced. Findings require lane, severity,
summary, concrete scenario, and Boolean `resolved`. Claims are explicitly
`verified` with evidence or `unverified` with a reason. Checks must use an ID and
exact command from target policy. Analysis kinds are:

- `claims_audit`
- `falsification`
- `failure_trace`
- `analogy_differences`
- `pattern_sweep`
- `new_assumptions`
- `artifact_lifetime`

Required conditional analyses must be present even when they do not apply; use
`not_applicable` with a reason only where target policy allows it.
Critical policy must require at least one verified claim, so an empty claims
array cannot vacuously satisfy the claims audit.

## What the gate derives

1. Resolve current source/target branches and SHAs plus canonical repository URL
   and immutable forge repository ID.
2. Prove the target commit is locally readable, then read policy from that Git
   object—not the source worktree.
3. For strict mode, prove the source object is readable, compute the merge base,
   and enumerate `git diff --name-only -z --no-renames`. Disabling rename
   detection exposes both the deleted old path and added new path.
4. Compute the minimum tier from target policy and the complete path set. The
   recorded tier may ratchet upward, never downward.
5. Validate schema and exact context/policy bindings before considering consent.
6. Require the selected tier's product coverage, verified-claims minimum,
   checks, claims policy, analyses, and evidence reference.
7. Derive `pass` or `blocked` from lanes, findings, checks, claims, and analyses;
   reject a stored verdict that disagrees.

Critical records cannot use local consent. Valid blocked trivial/standard
records may use the existing explicit-consent claim only when target policy
allows it; the hook logs that path. Missing or malformed evidence is invalid and
cannot be consented away.

## Reviewer workflow

Use the `adversarial-review` skill for plan and implementation refutation. Feed
it primary artifacts and a mechanically complete candidate set, not the
orchestrator's conclusion or another reviewer's verdict. It traces before
reading maker narrative and reports only findings backed by concrete failing
inputs or replayable traces.

For user-facing/installable changes, run `product-review` as a separate lane.
Product coverage and verdict are separate: `partial` describes how much was
exercised; it does not itself mean pass.

Post the redacted claims, checks, analyses, attempted falsifications, findings,
and remaining uncertainty to the PR/MR. The local record's `evidence_ref` points
there. Do not include secrets, tokens, or personal data.

## Legacy v1

Repositories whose exact target commit has no policy retain the old record:

```json
{
  "head_sha": "<exact source head reviewed>",
  "verdict": "pass",
  "findings": []
}
```

This compatibility path checks source SHA, unresolved HIGH/BLOCKER findings,
verdict, and the historical written-consent shape. It exists only to bootstrap
strict policy.

## Known limits

- `source_sha` is the exact reviewed source head, not a generated squash/merge
  commit. Integrated-result assurance requires a protected merge-ref/merge-queue
  CI check.
- The hook observes forge state before the merge command; only an atomic
  forge-side expected-head condition removes the final race.
- Claude Code and Grok currently invoke this hook. The validator is portable,
  but Codex and OpenCode runtime registration is separate work; do not claim
  local interception there yet.
- Same-family reviewers can share blind spots. Critical work still needs
  deterministic checks and an external human or different-family review at the
  forge boundary.
