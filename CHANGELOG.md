# Changelog

Notable changes per release. Newest first. Unreleased work accumulates at the
top and ships with the next tag.

Releasing: bump the PATCH version by default. A minor or major tier requires
the owner's explicit agreement for that specific release, recorded in the
release PR — "publish this" authorizes a release, never the tier.

## [Unreleased]

- feat(taste): `taste-police` — one generic hook that carries out `enforce:
  block`. It resolves the same folders the skill reads (project >
  `tastes-vendor` > user, replacing by name), takes the tastes whose `rule` the
  lint accepts, and tests `rule.match` against the command in process. No rule
  value ever reaches a shell, and adding a blocking taste changes no code: a
  test asserts the guard's own bytes are identical before and after a second
  blocking taste starts refusing. The refusal names the taste, its file, its own
  `remedy` and its own `override`; the override is honored inline on the command
  or from the environment, and a value that reads as off (empty, `0`, `false`,
  `no`, `off`) warns and still refuses. Both bounds are documented: `rule.match`
  caps at 200 characters (the lint refuses longer, so CI catches it) and only
  the first 4000 characters of a command are examined. A malformed taste is
  skipped with a warning and takes nothing else down; a hook that cannot run
  reports UNCHECKED rather than allowing quietly or refusing on its own
  uncertainty. Ships on both police lanes — `hooks/claude/taste-police.sh` and
  `plugins/taste-police.ts` — over one shared evaluator, so a taste cannot mean
  different things on different harnesses. `taste.enabled: false` makes it
  inert. Listing, adding and linting a folder stay conversational in the skill:
  no CLI. (#302)

## v0.7.4 — 2026-08-05

- feat(skills): `taste` — one markdown file per convention, read by every
  harness agentkit installs to. A taste carries frontmatter an agent can filter
  on (`name` as the key, `scope`, `strength`, `enforce`, an optional declarative
  `rule`, `provenance`) and a body stating the preference, why it holds, and how
  to apply it. Scopes resolve project > external > user > kit, replacing by name
  rather than merging, so a repository's own file overrides the policy it
  subscribes to and the override is visible in that repository's diff. Learning
  fires only at an explicit correction: dedupe by name before writing, fork
  one-off (use the named override, touch nothing) from durable (supersede in
  place, never a `-v2` file), gate ceremony on `strength`, and route the
  preference to the scope that owns it instead of forking it locally. This slice
  ships the format, the skill, and `skills/taste/scripts/lint.ts`, which refuses
  a malformed folder in CI rather than in a future session. Enforcement is
  configuration the owner sets, never a rank a taste earns — and `block` is
  honestly documented as behaving like `check` until the generic `taste-police`
  hook lands. (#301)

## v0.7.3 — 2026-08-05

- docs(designer): the altitude rule — clarity outranks detail. The centerpiece
  figure carries every stage of its story at a glance, headline + centerpiece
  must pass a ten-second newcomer test, zooms come after the overview and are
  labeled as zooms, and evidence supports a figure the reader already
  understands rather than leading it. Distilled from an owner review where the
  measured-richer page read worse than a plainer one. (#292)
- fix(designer): standalone pages carry their own persisted theme toggle. The
  scaffold themed correctly through `prefers-color-scheme` and `data-theme`
  overrides, but a page hosted without chrome (a product repo, a raw publish)
  had nothing stamping `data-theme`, so viewers could never flip themes and the
  second theme went unseen. (#288)

- feat(skills): `designer` — bespoke, artifact-grade design pages. Carries the
  per-subject design method (semantic color families over a three-level surface
  stack, dual token-level theming, a chosen type system) and a component
  grammar with a verified working scaffold: page header with chips, section
  eyebrows, legend keys, product-surface mockups (toolbar, rails, dotted canvas
  with SVG edges, inspector), flow strips, counter step cards, phase cards,
  non-goal lists, sequence lanes (ordered messages without a mermaid runtime),
  and acceptance checklists. Verification is measured, not eyeballed:
  full-scrollHeight capture in both themes, DOM-probed figure endpoints,
  overflow assertions, and computed ≥4.5:1 contrast for every semantic
  text/ground pair. `architect` routes design proposals and product-design briefs
  through it, and `publish-page` points bespoke raw design pages at it, so a PD
  comes out at the grade a Claude artifact produces without manual redesign.
  (#286)

## v0.7.2 — 2026-08-02

- feat(pages): issue 90-day device credentials with explicit `pages:write`
  and `pages:delete` scopes, enforce the scope required by each operation, and
  backfill existing devices through an immutable D1 migration. The account
  dashboard shows each device's grants and expiry, while a rejected stored
  credential starts device authorization again instead of leaving the
  publisher at an unactionable `401`.
- feat(pages): bound each device to 60 publish/delete operations per minute in
  D1, with a configurable ceiling and `Retry-After` on `429`. This complements
  the existing 5 MB page limit and 100-page per-account quota.

## v0.7.1 — 2026-08-02

- fix(pages): add a forward D1 migration for `page_access_tokens`. The accounts
  migration was squashed during active development after production had already
  recorded its filename, so D1 skipped the expanded file and invite revocation
  failed when it tried to clear a page-scoped access grant.

## v0.7.0 — 2026-08-02

- feat(pages): replace anonymous publishing with Assay accounts and per-device
  credentials. New pages are private and owned by the verified Assay user; the
  account dashboard lists their pages and publishing devices, creates revocable
  share links, grants and removes access by verified email, and revokes device
  credentials. The account control plane lives on `account.agentkit.sbs`, while
  arbitrary rendered HTML stays on `pages.agentkit.sbs`; a host-only session is
  exchanged for a random ten-minute capability scoped to one page, so published
  JavaScript never shares the dashboard's origin or cookie. The site deployment
  API remains separately credentialed on `agentkit.sbs`.
- feat(git-police): a branch WIP cap refuses creating a branch while unfinished
  ones are already open on the repository. `mr-police` has capped open merge
  requests at one for a while, but an agent that never opens an MR never meets
  that gate — measured on one repository, eleven unmerged branches against a
  single MR. Branch creation is the chokepoint that catches it.
  Finished is the forge's answer, never git topology, for the reason `wip`
  records: a squash-merged branch stays a non-ancestor of the default branch
  forever, and every git-only rule reports it as outstanding. Branches the forge
  says merged or closed drop out, as do branches with nothing committed and
  branches a worktree is holding. That last one matters: under one worktree per
  agent, counting held branches would refuse agent B a branch because agent A is
  mid-flight, and would name a branch whose deletion destroys a live checkout.
  The stale-branch rule already excludes those for the same reason, and a gone
  upstream is likewise left to it.
  `AGENTKIT_BRANCH_WIP_MAX=<n>` raises the ceiling, inline or from the
  environment. Exactly `off` disables the cap; any other unusable value (`0`,
  `-1`, a typo) warns and falls back to `1`, because a guard that a mistyped
  value switches off silently is the failure this rule exists to close.
  Three outcomes stay distinguishable: silence when the repository is clean, a
  refusal naming the branches when it is not, and an `UNCHECKED` reminder — never
  a refusal — when no forge could be reached, because blocking a developer on a
  network hiccup is worse than the sprawl. A forge call that fails or answers
  with something other than a JSON array is that third case, not an empty
  backlog.
- feat(issue-police): a new hook refuses `gh issue create` / `glab issue create`
  unless the issue body carries a `Disposition:` line. Presence only — the hook
  forms no opinion on the answer, and the issue-lifecycle skills teach what to
  write. Instructions alone are demonstrably routed around: a working one-MR cap
  was bypassed eleven times by simply never opening an MR.
- docs(issue-lifecycle): both lifecycle skills now separate three things that
  look identical at the moment you type `issue create`. New work is filed and
  branched. Scope carved out of the issue you are working on right now is a
  **deferral** needing the operator's sign-off, not a silent file. A review
  finding defaults to being fixed in the change that caused it; filing is the
  exception and has to be justified. Auto-filing every finding is what ran one
  repository's backlog to 34 issues in three days with 21 still open.

## v0.6.4 — 2026-08-02

- feat(themes): editorial typography for published pages, and a light mode that
  is a warm paper ground in its own right rather than an inversion of the dark
  palette. Headline clamps rather than sitting at a flat size, the lede is
  selected structurally so a markdown author gets it by writing a paragraph
  after the title, and prose, headings and full-bleed content sit at three
  distinct width tiers so a heading no longer overhangs the prose beneath it.
  A callout's label is now marked by the renderer rather than guessed at by
  position: `:first-child` counts element children, so CSS cannot tell a label
  from a bold phrase that merely happens to be the first element in a sentence,
  and every spelling an author writes — inline, a blank line inside the div, an
  `<h3>`, a paragraph the author wrapped themselves — renders identically, at
  one height, with the label taking its own rail's colour. Bold anywhere else
  stays body text. Every ink and ground pair the themes actually paint was
  recomputed on the new ground before shipping; the worst measures 4.84:1
- fix(diagram): one colour normalisation, applied to both the registered fill
  and the painted value and shared by the attribute and CSS-block paths.
  `rgb(1 2 3)`, `rgb(1,2,3)`, 3-digit, 6-digit and 8-digit hex are the same
  colour when they are the same colour, and an alpha-bearing paint is refused
  rather than silently flattened to an opaque `currentColor`. Previously a mark
  could ship half baked with nothing raised
- feat(diagram,pages): monochrome vendor marks are re-inlined as `<svg>` so the
  page theme drives their ink, since one baked grey cannot clear contrast on
  both the dark and the light node fill; full-colour logos are left untouched.
  `find-icon` searches the manifest and reports set, licence and colour class,
  and an unknown icon suggests real candidates. The doc theme gains a sticky
  labelled section nav in place of the unlabelled dot rail, and both themes gain
  `.callout` severities contrast-checked at 4.5:1. The hand-written light plate
  is gone — it stayed white in dark mode — so a page following the old plate
  recipe should drop it
- feat(wip): `wip` reports what was started and not finished in a repository —
  branches with age and commit count, worktrees with a loud warning on dirty
  ones, open merge requests or pull requests and what holds each, open issues
  you authored (separating those whose text says they were carved out of other
  work), and plans with unclosed gaps. GitHub and GitLab both resolve from the
  `origin` host, including self-hosted.
  Whether a branch is finished is the **forge's** answer, never git topology. A
  squash merge destroys the topological evidence by design, and measured against
  nine branches of known outcome every git-only rule called all seven merged ones
  outstanding: ancestry counts, two-dot and three-dot diffs, and an in-memory
  `merge-tree` tree comparison alike — the last passing a two-commit fixture and
  failing on a real repository, because a fixture whose default branch has not
  moved cannot distinguish the case it exists to prove. States are separated into
  merged (cleanup), closed-without-merging (a decision), open, and never-opened
  (the interesting one). With no forge reachable there is no local rule to fall
  back to, so the branch state is reported as UNKNOWN and marked DEGRADED rather
  than guessed at in the alarming direction.
  The headline counts unfinished branches only — branches, worktrees, issues and
  plan gaps are four different things with four different remedies, and one
  number covering all of them cannot be acted on; the rest are broken out on a
  `COUNTS` line. A branch with nothing committed, no worktree checked out on it,
  and no change ever opened is hidden as never-started, which on one real
  repository removed 20 of 41 branches (all worktree-harness bookkeeping) and
  took the headline from 150 to 4. The rule is structural rather than by name:
  having commits disqualifies a branch from being hidden, so it cannot bury a
  harness branch that did real work, and a dirty worktree keeps a zero-commit
  branch visible because that is where uncommitted work lives. What is hidden is
  counted and named in a NOTE
- feat(plan-gate): a plan may not be treated as done while its own gaps section
  lists work that is neither ticked, struck through, nor carrying an issue
  reference. `tools/plan-gate` is the single parser; `plan-police` is a
  PreToolUse hook on `Edit|Write` that judges the content an edit is about to
  land and refuses the edit, with `AGENTKIT_SKIP_HOOKS=plan-police` as the
  recorded exception. Plan layout is discovered from common conventions and
  overridable per repository under `wip:` in `.agentkit/config.yaml`

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
