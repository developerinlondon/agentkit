# Findings: acme-notes

Read-only analyze pass over `brief.yaml` + `ledger.yaml`, 2026-07-27.

## Contradictions

- **Free-tier project cap: 3 vs 5.** [C-001] (site:/pricing, "up to 3
  projects") vs [C-002] (repo:README.md, "up to 5 projects"). Both
  observed, both high confidence, same retrieval date — one surface is
  stale. The site inventory already marks `site:/pricing` as `revise`.

## Gaps

- No `alternative`-side evidence: the positioning names "hosted note SaaS"
  but no claim examines any specific alternative.
- Ulwick coverage is thin: only `execute` and `conclude` have product
  presence; `locate`, `monitor` and `modify` (finding an old note,
  noticing staleness, updating it) are unevidenced either way.
- Do-not-invent topics with no evidence in any direction: pricing history,
  customer counts, roadmap.

## Risks

- [C-004] (solo-developer audience) is inferred from the free-tier cap and
  the marketing framing — all vendor-controlled sources, site and README
  alike. A user interview or issue-tracker signal would move it.
- [C-007] (SOC 2) is `unverified` and load-bearing for any
  compliance-sensitive adoption decision; treat as absent until proven.
