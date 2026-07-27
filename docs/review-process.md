# Agent review process (review-police)

This is the **merge gate**, not a code-style linter. It blocks forge merges
unless an independent review record covers the exact commit being merged.

## What it is / is not

| | |
| --- | --- |
| **Is** | Mechanical gate: missing/stale/blocked review → merge denied |
| **Is not** | Security. Agents can write the record. Forge required approvals are real enforcement |
| **Honest path** | Reviewer writes pass/block → agent fixes HIGH/BLOCKER → re-review → merge via CLI |

Historical failure mode (2026-07-19): reviewer returned HIGH, merge ran in
parallel, agent judged the finding inert, machine broke as predicted.
`review-police` makes that path hard without user-written consent.

## Artifacts

| Artifact | Path | Committed? |
| --- | --- | --- |
| Review record | `.agentkit/reviews/<source-branch-slug>.json` | **No** (gitignored) |
| Product manifest | `.agentkit/product.yaml` | **Yes** (product-review skill) |
| Audit log | `~/.agentkit/review-audit.log` | n/a (machine-local) |

Branch slug: feature branch name with `/` → `__`
(e.g. `feat/grok-hook-compat` → `feat__grok-hook-compat.json`).

### Record shape

```json
{
  "head_sha": "<full sha of the commit reviewed>",
  "verdict": "pass | blocked",
  "findings": [
    {
      "severity": "BLOCKER | HIGH | MEDIUM | LOW",
      "summary": "…",
      "resolved": true
    }
  ],
  "user_consent": {
    "granted": true,
    "quote": "<user's exact words allowing the merge>",
    "at": "<ISO-8601>"
  }
}
```

Gate rules (summary):

1. Resolve **real** source branch + head sha from the forge (MR/PR), not the local checkout.
2. Require a record for that branch.
3. Record `head_sha` must equal the sha being merged.
4. Unresolved **BLOCKER** or **HIGH** findings → deny unless `user_consent.granted` is true with a quote.
5. `verdict` must be `pass` (or consent path).

## Who writes what

| Actor | May write |
| --- | --- |
| **Reviewing agent** (separate from implementer) | `head_sha`, `verdict`, `findings` |
| **Implementing agent** | Fixes code; may re-request review; must **not** invent a pass |
| **User only** | `user_consent` when deliberately overriding unresolved HIGH/BLOCKER |

Overrides are logged to `~/.agentkit/review-audit.log`. Prefer fixing findings.

## How to run a review that the gate accepts

1. Implement on a feature branch; open MR/PR.
2. Spawn or hand off an **independent** reviewer (diff review skill, separate session/subagent).
3. Reviewer writes `.agentkit/reviews/<slug>.json` for the **MR source branch** and the **head sha the forge will merge**.
4. If blocked: implementer fixes, push, re-review with updated `head_sha`.
5. Merge only via CLI paths the hook inspects (`glab mr merge`, `gh pr merge`, …). MCP merge tools are denied.

Product review (build/run/use) is a separate lane — see
`skills/product-review/`. It is **not** required by review-police today; absence
of `.agentkit/product.yaml` is a product-review finding, not a merge blocker
unless you raise that policy later.

## Agent / human checklist

```text
implement ──► independent review ──► record pass for head_sha
                    │
                    ▼
              unresolved HIGH/BLOCKER? ──yes──► fix or user_consent
                    │
                   no
                    ▼
              glab mr merge / gh pr merge  (review-police allows)
```

## Grok / Claude

Same hook script. After dual-payload support, Grok shell merges are gated when
the tool is `run_terminal_command` with a merge command; MCP merge tool names
still deny. See [docs/grok.md](./grok.md).
