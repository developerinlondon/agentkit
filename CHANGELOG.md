# Changelog

Notable changes per release. Newest first. Unreleased work accumulates at the
top and ships with the next tag.

## [Unreleased]

## v0.6.0 — 2026-07-30

- feat(memory): opt-in **memory** kit — a per-project `brain/` vault the agent
  reads at session start, with `reflect`/`meditate`/`ruminate` skills that
  route recurring lessons into hooks and rules before notes, two vault-plumbing
  hooks, and one-line per-kit install shims under `kits/<id>` (#227)
- ci: the affected-tests budget matches its full-suite escalation path, which
  exceeds 30 minutes on the self-hosted Mac
- ci: merge-queue readiness, cancellation-aware gate, de-flaked git fixtures
  (#229)

## v0.5.3 — 2026-07-30

- fix(site): the advertised version derives from the release tag at build time;
  the committed copy that went five releases stale is gone (#220)
- feat(install): `~/.agentkit/version` stamp, and a session-start notice when a
  newer release exists — notify only, cached a day, silent on any failure (#225)
- ci: macOS jobs run on the self-hosted Mac when it is online and idle, with
  the hosted runner as the automatic fallback; fork PRs never reach it (#219)
- fix(tests): the mermaid browser harness retries a not-yet-ready devtools
  endpoint instead of dying on Chrome's non-atomic port-file write (#223)
- docs: archived versions build from their own git tags at publish time instead
  of living as page copies on `main` that current code could break (#217)

## v0.5.2 — 2026-07-30

- the install unit is now a **kit**: `skills/KITS` manifest, `--with <kit>`,
  state in `~/.agentkit/kits`; four kits — `core`, `product`, `advisory-review`,
  `adversarial-review` (#215)
- the merge-gate kit is named **adversarial-review** for what it does
  (previously `strict-review`, before that `review`)
- upgrades inherit the recorded selection across the rename and retire stale
  artifacts automatically: the old state file and Claude plugins under retired
  ids; hand-edited state files (missing trailing newline, CRLF) survive intact

## v0.5.1 — 2026-07-30

- deploys prune what the build no longer contains, so renamed pages stop being
  served from stale copies (#213)

## v0.5.0 — 2026-07-30

- two independent, explicit opt-in review modes: `advisory-review` (a
  non-authoring reviewer pass as an always-loaded instruction) joins
  `strict-review` (adversarial lane + evidence records + merge gate) (#206)
- the GitHub Release is published as the last act of a tag push (#209)
- the README skills table is generated from the tree (#212)

## v0.4.5 — 2026-07-30

- the marketing site lives in this repository (#205)
- installs resolve the newest release tag, not `main` (#203)
- Starlight docs site in-repo: generated reference tables, versioned releases (#196)

## v0.4.4 — 2026-07-30

- pkg-police: close the bypasses v0.4.3 shipped (#199)

## v0.4.3 — 2026-07-30

- pkg-police: package manager is configurable, inferred from the lockfile by
  default (#194)

## v0.4.2 — 2026-07-30

- the `review` group is renamed `strict-review`; `--with review` stays as an
  alias (#192)

## v0.4.1 — 2026-07-30

- curl-pipe bootstrap: one command installs the latest release (#185)
- review-discipline core instruction layer (#188)
- installs stop wiping foreign helpers from the shared hooks lib dir (#184)

## v0.4.0 — 2026-07-29

First tagged release. The kit as it stood: police hooks on four surfaces
(Claude Code, OpenCode, Codex, Grok), the skills tree with the interactive
group picker, explicit opt-in review machinery, product-intelligence briefs
and slide decks, diagram source extractors and vendor icon packs, the
preflight build gate with the BUILD-DISCIPLINE failure catalogue, and the
multi-page site on the apex host.
