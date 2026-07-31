# Changelog

Notable changes per release. Newest first. Unreleased work accumulates at the
top and ships with the next tag.

## [Unreleased]

## v0.6.3 — 2026-07-31

- perf(ci): `agentkit:test-full` runs the slice inventory as concurrent per-file
  `bun test` children (`scripts/run-test-slices.ts`), buffering each file's
  output until it finishes so the transcript stays readable; a child that ends
  without a completion summary is reported as a failure rather than counted as
  a pass. CI wall clock drops from 366s to 108-151s on `ubuntu-24.04` and from
  608s to 154s on the self-hosted macOS runner. Lane count defaults to
  `min(4, cores/2)`; `--lanes N` overrides it (a flag, because the installed
  `bounded-run` neither forwards `AGENTKIT_TEST_CONCURRENCY` nor accepts an
  `env NAME=value` prefix) and `--serial` restores the one-at-a-time run
- perf(tests): the install suites set `AGENTKIT_SKIP_SKILL_DEPS=1` — exactly one
  test, the first in `tests/install-prompt.test.ts`, still resolves and builds
  real skill dependencies
- fix(ci): `tests/hook-supervisor.test.ts` runs with the machine to itself. It
  asserts `fail-closed-hook.sh` relays its child inside a one-second deadline,
  which lane contention makes the child miss — the supervisor then fails closed
  correctly and the assertion breaks on load rather than on behaviour

## v0.6.2 — 2026-07-31

- fix(site): archived doc versions carry an injected, version-independent
  switching banner — a tag-era page without the picker no longer strands the
  reader; the banner reads `/docs/versions.json`, so old archives list even
  releases that postdate them
- feat(site): the current docs build emits `/docs/versions.json`, the one
  source the header picker and the archive banner share
- ci: the docs publish builds and uploads an archived site per release, so its
  timeout moves from 20 to 45 minutes — the v0.6.1 tag run died mid-upload,
  which is why v0.6.1 has no GitHub Release or docs deploy (#240)
- ci: a tag reuses the green full-suite run of its exact commit instead of
  re-running both platform suites on a SHA the main push just tested (#243)
- ci: archives publish incrementally — a slug whose live `archive-stamp.txt`
  matches (tag, tag sha, banner hash) is neither rebuilt nor re-uploaded, and
  the prune spares it; dropped slugs still prune (#243)

## v0.6.1 — 2026-07-31

- **Enforcement is now opt-in everywhere** (#237). The `resource-police` and
  `delegation-police` units default to disabled: nothing is bounded and no
  delegated/privileged command is blocked until the corresponding section in
  `~/.config/agentkit/config.yaml` sets `enabled: true`. The Claude/Grok hook
  and OpenCode plugin read the config at runtime; the Codex policy files
  install, regenerate, or uninstall from the config on each `install.sh` run
- feat(config): `resource-police.bounded` class list tunes which command
  families require `bounded-run` (`js-packages`, `js-scripts`, `typescript`,
  `playwright`, `cargo`, `go`, `moon`, `python`); the installed Codex resource
  policy is filtered to the same classes
- fix(codex): the delegation policy no longer blanket-blocks engine
  administration groups — read-only diagnostics (`docker system df`,
  `docker buildx ls`, `docker volume ls`, `podman container inspect`, …) are
  allowed when the unit is enabled, with forbidden/allowed lists kept disjoint
- fix(codex): `pkg-police.rules` installs only when the config names
  `pkg-police.manager: bun` explicitly, matching the configurable-manager
  design; `auto`/`off`/other managers remove it (#193)
- fix(bounded-run): `env VAR=value …` prefixes are unwrapped and the real
  child command classified, so `bounded-run -- env CI=1 bun test` works while
  privileged/delegating children stay refused; the Codex rules no longer
  reject `env` as a bounded-run child
- feat(install): managed Codex policies reconcile on upgrade — a policy that
  is deselected, disabled, or platform-unsupported is removed from
  `~/.codex/rules/` without touching user rules such as `default.rules`
- feat(install): `install.sh --uninstall` removes everything the installer
  wrote and reverts its managed edits in `~/.claude/settings.json`,
  `~/.claude/CLAUDE.md`, `opencode.json`, Codex `config.toml`/`hooks.json`,
  and `~/.bashrc`, preserving user content; a new `uninstall` skill guides
  per-kit removal (`--drop <kit>`) and full removal
- fix(site): the docs version picker is back, and the site title on docs pages
  links to the main site again
- docs: enforcement pages describe the opt-in model; the stale claim that
  `review-discipline` is a core instruction is corrected; weakness-flavoured
  warning callouts reworked into neutral notes

## v0.6.0 — 2026-07-30

- feat(memory): opt-in **memory** kit — a per-project `brain/` vault the agent
  reads at session start, with `reflect`/`meditate`/`ruminate` skills that
  route recurring lessons into hooks and rules before notes, two vault-plumbing
  hooks, and one-line per-kit install shims under `kits/<id>` (#234)
- ci: the affected-tests budget matches its full-suite escalation path, which
  exceeds 30 minutes on the self-hosted Mac (#234)
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
  of living as page copies on `main` that current code could break (#228)

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
