# Findings: agentkit

Read-only analyze pass over `brief.yaml` + `ledger.yaml`, 2026-07-28.

## Contradictions

- None recorded. The two acquired surfaces (repo docs, GitHub metadata) do
  not disagree with each other.

## Gaps

- Only one origin family was acquired: everything cited is the repository
  or its GitHub metadata — all vendor-controlled. The website
  (agentkit.sbs) was not crawled, so no independent surface corroborates
  the README's story.
- Ulwick workflow coverage and job stories are absent from the brief —
  the acquired corpus describes what ships [C-001], not how an operator's
  day changes.
- Do-not-invent topics with no evidence in either direction: competitors,
  install counts, roadmap.

## Risks

- Distribution without releases [C-004, C-005] means consumers track a
  moving main; there is no version to pin or roll back to.
- Every load-bearing claim traces to the project's own README or repo
  metadata; nothing in the ledger is third-party.
- [C-008] (minimal external adoption) is inferred from two weak public
  signals; a single blog post or fork could move it either way.
