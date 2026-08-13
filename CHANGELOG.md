# Changelog

Notable changes per release. Newest first. Unreleased work accumulates at the
top and ships with the next tag.

Releasing: bump the PATCH version by default. A minor or major tier requires
the owner's explicit agreement for that specific release, recorded in the
release PR — "publish this" authorizes a release, never the tier.

## [Unreleased]

- fix(hooks): **`issue-police` catches an issue filed through the REST API, not just the
  subcommand.** It matched `gh|glab issue create` only, so `glab api --method POST
  <project>/issues` filed an issue with no `Disposition:` line and no refusal — the guard was
  present and silent. The URL is normally quoted, and quoted strings are emptied before the
  trigger match, so the path is now read from the original command truncated at the first body
  flag: an issues URL quoted inside a description is still not a creation. Reads, updates, and
  notes on an existing issue remain untouched. `issue-police.sh` also joins the hooks whose
  packaged plugin copy is asserted byte-for-byte, so the pair cannot drift again.

## v0.7.17 — 2026-08-13

- fix(ci): **the docs publish gets the same Hugo binary the build gets.** `HUGO_BIN` was set as a
  prefix on `build.sh`, so it reached that command and not the deploy chained after it; the archive
  build fell back to a binary the runner does not install, and v0.7.16 published everything except
  the documentation.
- fix(ci): **a self-hosted Mac can be taken out of rotation.** Online and idle is not health: a
  runner whose network cannot reach the release CDN still won the job and failed at toolchain
  install. Measured on it — 4.1 MB/s from Cloudflare against 38 KB/s from GitHub's release CDN on
  both IPv4 and IPv6 — so the repository variable removes it without deregistering it.

## v0.7.16 — 2026-08-13

- feat(docs): **the documentation has its own host, `docs.agentkit.sbs`.** The worker serves it
  from the same keyspace by prefixing the path, which leaves that host read-only by construction.
  The marketing host refuses `/docs/*` rather than serving it with root-relative assets it cannot
  resolve.
- fix(docs): **an archived version had lost its stylesheet.** It was published as a copy of the
  `/docs/` build, so it referenced a content-hashed asset name that the next release replaced. An
  archive is now built against its own base URL and is self-contained. Version history restarts on
  the new host.
- fix(docs): the version picker offers **every patch of the current minor**, not only older minors —
  the release you shipped last week is the one most likely to be wanted back. It is styled rather
  than left as the platform control.

## v0.7.15 — 2026-08-13

- feat(docs): **kits and harnesses are first-class sections.** Kits moved out of Getting started,
  where it had been filed as an install topic, to `/docs/kits/`. Harness support had no page at all
  despite being mentioned across five; `/docs/harnesses/` now states what each of the four gets and
  which guards it can carry, rendered from the declarations the installer reads.
- fix(docs): **every section landing introduces its section.** Concepts, Getting started and
  Extending rendered as a title and nothing else.
- fix(docs): the breadcrumb keeps the home crumb the theme drops, which on a docs-only site is the
  documentation front page; the wordmark leaves for the site rather than linking to the page the
  reader is already on; body prose is set in mono to match it; and Pages gains an accounts section
  covering who signs in and how.
- fix(docs): **a published version tree could be pruned.** The deploy spared only versions the
  picker offers, and a version in the current minor is never offered as an archive, so
  `/docs/0.7.14/` was one deploy from deletion. Every published tree is spared now.

## v0.7.14 — 2026-08-13

- feat(docs): **the documentation site is now Hugo and Hextra.** The Astro build, its archive
  builder and its deploy script are gone; `/docs/` is the Hextra build, published by the same
  upload path as before. The docs job went from eight to nine minutes to under a minute, because
  a full site build is now about a fifth of a second rather than half a minute.
- feat(docs): **one-click theme toggle and a version picker in the navbar.** The theme control is
  a single button rather than a three-option menu, and a release now publishes to
  `/docs/<version>/` as well as `/docs/`, so readers can move between versions.
- change(docs): **version history starts here.** Twenty-one published archives were removed rather
  than carried forward: each was built by the previous generator, labelled itself the latest of its
  day, and documented a pre-release product.

- feat(skills): **`clickup-task-lifecycle`, in a new opt-in `clickup` kit.** Task-first workflow
  hygiene for teams tracking work in ClickUp: status current on every touch, closure notes before
  closing, sprints modelled as Lists rather than invented custom fields, and KPIs in custom fields
  or Goals rather than prose. Two gates keep it out of everyone else's way — the kit is opt-in
  (`--with clickup`), and the skill reads `agentkit.clickup.list` from per-repo git config and
  stays inert where that is unset, so one machine can carry it for ClickUp repos while GitLab or
  GitHub repos on the same machine never see it.

## v0.7.13 — 2026-08-09

- fix(installer): **the remembered kit selection is now the active installed set.** Deselecting
  `product`, `memory`, or either review kit removes its AgentKit-managed skills, hooks, settings
  wiring, prompts, tools, and Claude plugin instead of leaving the optional workflow discoverable
  indefinitely. Canonical AgentKit artifacts are reconciled exactly; unrelated user-owned client
  skill directories and third-party plugins remain untouched.

## v0.7.12 — 2026-08-06

- feat(taste): **a rule declares a kind agentkit implements, and parameterises it** (#328). The
  rule vocabulary was one regular expression over the command string, which cannot answer a
  question about state. It is now a registry of named predicates: each kind declares the fields
  it needs, the validation the lint runs, and the evaluator the hook runs. `kind: command` is
  the first entry with exactly its previous behaviour. An unknown kind is refused by the lint
  naming the kinds that exist, and **skipped with a warning by the hook** rather than crashing
  it, so a taste vendored from a source on a newer agentkit cannot brick an older one. Taste
  data still executes nothing: a hostile source can pick a check and word a refusal, and at
  worst over-block you.
- feat(taste): **`kind: git-tag-sequence` refuses a release tag that does not follow the tags
  already in the repository** (#328). `policy` picks the ordering — `no-duplicate`,
  `no-backwards-in-line` (a tag below the highest on its own major.minor line, so v0.6.5 while
  v0.7.11 exists stays a legitimate maintenance release), or `strict-successor` (only the
  immediate next patch of the highest tag). Non-semver tags are ignored throughout. The
  proposed tag is read from `git tag`, `git push` and `gh release create`; `match` overrides
  that reading, its first capture group being the tag. It deliberately does **not** fail closed
  like the vendoring guard: outside a repository or with no tags there is nothing to check and
  the command passes silently, and where git cannot answer it reports `UNCHECKED` and allows —
  never a silent allow. The reasoning for the asymmetry is in the skill, bound to tests.

## v0.7.11 — 2026-08-06

- fix(taste): **a sync stages each scope separately, so both may declare a source of the same
  name.** Staging was keyed on the source name alone, so a machine source and a repository
  source sharing a name were fetched into one checkout and the second died on
  `remote origin already exists` — taking the whole run with it, both scopes left unvendored.
  The owner hit it running the shipped release: a machine-level `public` and this repository's
  own `public` are two subscriptions to one upstream, which the scopes are built to allow.
- test(taste): the GitLab arm of the visibility prober is covered in the positive direction —
  a private `origin` beside a public `upstream` must read _private_. The public-side case
  passes just as well when the arm asks about the wrong repository, so only this one shows the
  URL reaching `glab` is the one being written into. The GitHub arm already had its counterpart.

## v0.7.10 — 2026-08-06

- feat(taste): **a taste source installs at the machine level or at the repository level**, and
  both apply. Declared in `~/.config/agentkit/config.yaml` a source vendors into
  `~/.agentkit/tastes/external/` with `~/.agentkit/tastes.lock`, and every repository on the
  machine reads it — declare it once, nothing copied into any checkout. Declared in a
  repository's `.agentkit/config.yaml` it keeps vendoring into that repository, which is what a
  team, a CI runner or an agent handed only a container needs. Precedence is now **project >
  project external > user > user external > kit**: the more specific location wins, and inside
  one location the owner's own tastes beat the ones they pulled in. The two lists no longer
  shadow each other, and a resolution names which of the four layers a winner came from.
- feat(taste): **a sync run inside a repository refreshes both scopes**, reporting each
  separately and writing each store's own lock. Run anywhere else, only the machine scope has
  anything to do. A scope declaring no sources is said to be empty rather than swept.
- feat(taste): **vendoring a private source into a public repository is refused.** A source
  carries `visibility: public | private`, required of any source a repository vendors because
  that snapshot is committed there; the target's visibility is read from its forge with `gh` or
  `glab`. Upgrading: an existing repository-level source must add `visibility:` to its entry in
  `.agentkit/config.yaml`, and a sync names the source and refuses until it does. A
  machine-level source needs no such key, since nothing of it is committed anywhere. It fails closed — a target that cannot be shown to be private is refused too, and an
  internal repository counts as public. `AGENTKIT_TASTE_TARGET_PRIVATE=1` asserts only the fact
  the tool could not establish: a target the forge answered _public_ for stays refused with it
  set. The machine level is gated only where it publishes — see the work-tree fix below.
  The guard exists because the leak happened here: this public repository carried a vendored
  copy of the owner's private business taste set, seven of whose files named business
  identifiers. The rule against it was a `check` taste — prose, which nothing mechanical
  enforced.
- fix(taste): **the forge is asked about `origin` by name.** The first cut read the URL from
  `origin` but then ran `gh repo view` with no repository, and both CLIs resolve one from _all_
  remotes by their own precedence — `gh` puts `upstream` first. On a checkout with a second
  remote the guard therefore judged a repository nobody named and printed the verdict against the
  one it had read: a fork whose `upstream` is private would vendor a private source straight into
  the public `origin`, reporting that `origin` was private. A remote URL beginning with `-` is
  refused before a CLI sees it, the same care `taste.sources` already takes with `repo` and `ref`.
- fix(taste): **the machine store is judged too when it sits inside a git work tree.** "Nothing is
  published at the machine level" was asserted rather than checked, and a home directory that is
  a dotfiles repository publishes exactly as a repository does. Outside a work tree nothing is
  probed and nothing changes.
- fix(taste): an override value of `' "0" '` read as _granted_ — `readOverride` unquoted before
  trimming, so padding outside the quotes survived. It now trims, unquotes, and trims again.

## v0.7.9 — 2026-08-06

- refactor(taste)!: **external sources live under `.agentkit/tastes/external/`**, not a sibling
  `tastes-vendor/`. One tree with two origins — the repository's own tastes at the root, a
  snapshot of each declared source beneath — instead of two folders implying two concepts.
  Precedence is unchanged; the project layer now stops at `external/`, so a snapshot can never
  take the precedence the repository holds over it.
- refactor(taste): **`external` is reserved at a tastes root**, and linting the root in one
  invocation is now correct: the owner's files are one dedupe scope, each source its own.
- refactor(taste): **migration with one release of grace.** A sync finding `tastes-vendor/`
  moves it and says so; resolve and the lint read the old path meanwhile, with one line naming
  the new one. Nothing outside `external/` and the lock is ever written.
- docs(taste): **a taste that loads, loads whole** — never a summary, never a first sentence
  standing in for the file. A partial preference is worse than an absent one, because it is
  acted on with confidence. "Hold a summary, open the file when it matters" is a prose
  discipline, and this repository has already watched one of those get routed around; the
  taste system cannot be built on the failure it exists to fix.
- docs(taste): **selection is structural, not lossy.** Where a folder is large enough to
  matter, filter by `category` — and load every `check`, `block` and `require` taste whatever
  its category. Filtering decides which tastes load, never how much of one loads.
  `enforce: block` is unaffected either way: the hook reads the files itself, out of process.

## v0.7.8 — 2026-08-05

- fix(designer): three refinements from the fourth acceptance run. The token contract now states
  the contrast bar for text on an `--x-band` ground — calmer is a matter of saturation, never of
  the 4.5:1 floor a large ground still owes the text it carries. "Measure, don't estimate" now
  says a centerpiece laid out in CSS grid or normal flow satisfies it structurally, so a
  grid-built bespoke figure no longer reads as a rule violation; the rule binds wherever a
  coordinate is authored by hand. And the scaffold gains `.filecard` — an artifact rendered as
  the file it is: path header, optional badges, the file's verbatim text, the prose it carries —
  with a grammar row routing "a file or config the page is about" to it. The scaffold demos it in
  a `.pair` row beside the table that annotates its fields, because a narrow card alone would
  teach an author to leave dead space next to it. Verified by the skill's own rules: scaffold
  rendered at 1280 px in both themes at the measured 2900 px scrollHeight, 150 painted
  text/ground pairs per theme clearing 4.5:1 (light min 4.85, dark min 4.51), all six
  `overflow-x` wrappers unclipped, and the row collapsing to one column below its 860 px
  breakpoint. (#299)

## v0.7.7 — 2026-08-05

- fix(taste): `resolveTastes(cwd)` threw `TypeError: The "paths[0]" property must be of type
  string, got undefined` four frames deep in `configFiles`, because `home` had no default and
  only the fixtures ever passed one. `home` now defaults to `homedir()` on the entry points
  that read it — `resolveTastes` and `configFiles` — and `readSources` passes its optional
  `home` and `env` straight through rather than carrying a second copy of the same default.
  Fixtures still override both. (#313)
- fix(taste): linting `.agentkit/tastes-vendor/` — the vendor root rather than one source —
  reported `duplicate name "release-tier"` across two sources, reading the stacking feature as
  an error while each source linted clean on its own. The linter now treats every immediate
  subdirectory of a `tastes-vendor` root as its own dedupe scope and names every finding by
  its source, so a name two sources both define is the override it was subscribed for. Inside
  a single source a name in two category folders still collides, and a `.md` sitting loose at
  the vendor root — which nothing writes and nothing reads — is refused rather than passed
  over. (#312)
- fix(taste): sync's git steps ran under `Bun.spawnSync`, so the 60s per-step bound had no way
  to fail: removing it did not turn a test red, it wedged the runner, because a blocking spawn
  holds the thread the deadline's timer would need. The steps are spawned asynchronously now
  and the deadline is an interruptible timer — same bound, same `unreachable within Ns`
  message, same all-or-nothing write. `syncSources` is `async` accordingly. Verified by the
  mutation the change exists for: with the kill removed, the sync suite went red in 6s where
  it previously had to be killed from outside after minutes. (#309)

## v0.7.6 — 2026-08-05

- feat(taste): **external sources** — a taste is no longer confined to the repository it was
  written in. `taste.sources` in `.agentkit/config.yaml` (or the user config) declares an
  ordered list of git repositories whose files are tastes; the skill's own
  `scripts/sync.ts` fetches each at its `ref`, **lints it before copying a single file** —
  a source whose tastes the lint refuses is named, with its files, and nothing enters the
  tree — snapshots the taste files into `.agentkit/tastes-vendor/<name>/` and pins them in
  `.agentkit/tastes.lock` (name, repo, ref, commit, and the date that pin was taken, which
  moves only when the pin does, so an unchanged re-sync is an empty diff). Only those two
  paths are ever written; a source dropped from the config loses its vendored copy, and
  anything that is not a `.md` taste stays upstream, so nothing executable rides in with the
  words. Resolution stacks the sources in declaration order — a later source wins a name an
  earlier one also defines, project still beats external and external still beats user — and
  `taste-police` inherits it by resolving the same folders. Both snapshot and lock are
  committed, so a fresh clone with no network and no reachable remote reads and enforces the
  policy from the working tree alone. Sync is skill-driven like the rest of it: no CLI, no
  PATH tool. A lock bump lands as an ordinary merge request whose diff **is** the text
  agents will start reading. (#303)
- fix(taste): a source's `ref` could make git run a program. git parses options after
  positionals, so `ref: --upload-pack=touch /tmp/pwn` against a local or `file://` remote
  executed that command during the fetch — before the sync reported the failure. Two
  independent stops now: `sources.ts` refuses a ref that is not a plain branch, tag or commit
  name (leading `-`, spaces, substitutions, `..`, `@{`, a `.lock` suffix), and every git
  invocation carrying a config-supplied value passes `--end-of-options`. The `ext::` transport
  is pinned off with `-c protocol.ext.allow=never` in the same audit, and a `repo` naming any
  `scheme::command` transport helper is refused at the boundary — verified both ways: with the
  pin removed and a git config that re-enables the helper, `repo: ext::touch /tmp/pwn` creates
  the file. (#303)
- fix(taste): sync bounds every git step at 60s (`STEP_TIMEOUT_MS`). `GIT_TERMINAL_PROMPT=0`
  answers a credential prompt but not a host that accepts a connection and never replies,
  which held a session past two minutes. On expiry the source fails with `unreachable within
  Ns` and the all-or-nothing rule stands: nothing is written. (#303)
- feat(taste): the listing surface gains a `source` column, and a taste the lint refused is
  now named in the listing as skipped rather than dropped from it — the reasoning `UNCHECKED`
  already carries, applied to the one row someone is most likely asking about. (#303)
- **Deferred, on the owner's word rather than silently:** `mode: reference` — the
  per-machine taste cache with `on_unreachable`, `max_cache_age` and atomic swap — is
  declared in the design but not built. Vendored is the default, and the topology this was
  designed for uses only vendored, so the cache had no day-one users. Declaring
  `mode: reference` is an error that names the deferral; it never falls back to committing
  something the owner did not ask to commit. (#303)

## v0.7.5 — 2026-08-05

- feat(taste): `taste-police` — one generic hook that carries out `enforce:
  block`. It resolves the same folders the skill reads (project >
  `tastes-vendor` > user, replacing by name), takes the tastes whose `rule` the
  lint accepts, and tests `rule.match` against the command in process. No rule
  value ever reaches a shell, and adding a blocking taste changes no code: a
  test drops a second taste into the folder mid-run and it starts refusing, with
  no guard source naming anything it enforces. The refusal names the taste, its file, its own
  `remedy` and its own `override`; the override is honored inline on the command
  or from the environment, and a value that reads as off (empty, `0`, `false`,
  `no`, `off`) warns and still refuses. Three bounds keep someone else's regular
  expression from taking the session: `rule.match` caps at 200 characters (the
  lint refuses longer, so CI catches it), only the first 4000 characters of a
  command are examined, and the match itself runs on an abandonable thread with a
  250ms deadline — length is not safety, since `(a+)+$` is eight characters and
  doubles its work per character. The deadline lives in the evaluator rather than
  in either adapter, so the OpenCode lane, which matches inside the editor's own
  process where no outer timeout can reach, inherits it. A malformed taste, or
  one whose pattern outruns the deadline, is skipped by name and leaves every
  other taste binding; a hook that cannot run reports UNCHECKED rather than
  allowing quietly or refusing on its own uncertainty. Ships on both police lanes — `hooks/claude/taste-police.sh` and
  `plugins/taste-police.ts` — over one shared evaluator, so a taste cannot mean
  different things on different harnesses. `taste.enabled: false` makes it
  inert. (#302)
- feat(taste): managing the folder is **skill-driven, no CLI** — an owner
  decision, recorded here because the obvious shape was a `taste list|add|lint`
  command and there deliberately is none. `SKILL.md` carries the three surfaces
  instead: listing resolves to one row per name (scope, strength, enforce) and
  names the layers a scope shadowed, since the override is the answer someone is
  usually after; a dictated taste is a first-class capture path running the same
  dedupe, routing and merge-request discipline as a correction, asking for the
  why rather than inventing it and earning no enforcement by being dictated; and
  every write is linted with the skill's own `scripts/lint.ts` before the diff is
  shown, because a taste that fails the lint is not written yet. `lint.ts` stays
  skill-internal plumbing rather than becoming a PATH tool. (#302)

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
