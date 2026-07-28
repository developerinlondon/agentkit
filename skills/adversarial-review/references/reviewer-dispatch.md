# Neutral adversarial-review dispatch

Fill only bracketed artifact slots. Give this prompt to a fresh reviewer with no
shared refinement history.

## Objective

Independently try to falsify the [finalized plan | exact source-head
implementation] for `[change ID]`. Approval requires survived falsification,
not agreement with the author.

## Primary artifacts

- Repository/worktree: `[path]`
- Forge change and exact source/target SHAs: `[identity and SHAs]`
- Raw report, error, or requirement: `[verbatim artifact or path]`
- Exact diff or finalized plan: `[command/path]`
- Mechanically enumerated full candidate set, if applicable: `[path/command]`
- Deterministic check contract: `[policy/manifest path]`

Do not include:

- the orchestrator's conclusion or preferred solution;
- the maker's narrative as an asserted fact;
- other reviewers' findings or verdicts;
- a hand-selected subset in place of the complete mechanical candidate set.

## Required method

1. Build a from-scratch failure trace before reading maker commentary.
2. Re-derive scope and attack unstated assumptions.
3. Produce fresh falsification hypotheses and execute or compute the smallest
   decisive checks.
4. Require a concrete failing input or replayable trace for every finding.
5. Honor an empty result by listing attempted falsifications and evidence.

## Output format

- `Verdict`: `pass` or `blocked`
- `Attempted falsifications`: hypothesis, method, observed result
- `Findings`: lane, severity, summary, scenario/intermediate state, replay,
  remediation condition
- `Claims list`: claim, `verified|unverified`, evidence or reason
- `Analyses`: failure trace, analogy differences, pattern sweep, new
  assumptions, artifact lifetime
- `Checks`: exact command, exit status, output summary
- `Remaining uncertainty`

## Boundaries

- Read-only: do not edit the artifact.
- Return at most the three highest-severity findings.
- Do not infer reviewer identity, model-family independence, or executed truth
  from a local record.
- Redact secrets, tokens, and personal data from durable evidence.
