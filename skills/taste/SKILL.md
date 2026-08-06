---
name: taste
description: >-
  Load and maintain tastes — one small markdown file per convention, committed to the
  repository it governs or kept in your home directory, telling every harness how this
  owner wants work done. Load them before acting, re-read a `check` taste immediately
  before an action it covers, and capture a correction as a taste instead of losing it.
  Triggers: "from now on", "always/never do X", "that is not how I want it", any
  correction that is a preference rather than a bug, and any question about where a
  convention lives or why an agent behaves a certain way.
---

# taste

A taste is one preference, in one file, that outlives the session it was stated in. The
folder is a dictionary keyed by `name`, not a record: files are added, rewritten, and
deleted, and the same `name` at a higher scope wins outright.

Nothing here is learned invisibly. A taste is written only at an explicit correction, and
its whole output is a diff someone can read, reject, or amend.

## First: is this skill on?

Read `taste.enabled` and `taste.learning` from `.agentkit/config.yaml`, falling back to
`~/.config/agentkit/config.yaml`. Both default to `true` when the key or the file is absent.

- `taste.enabled: false` — this skill is inert. Load nothing, write nothing, and say so if
  asked why a taste was ignored.
- `taste.learning: false` — load and honor tastes, but never write or update one. A
  correction still deserves an answer: say the preference would have become a taste, and
  what it would have said.

## Where tastes live

Precedence is **project > project external > user > user external > kit**. The more specific
location wins, and inside one location the owner's own tastes beat the ones they pulled in. The
higher scope replaces the lower one for the same `name` — two tastes are never merged into a
third nobody wrote.

| Layer            | Path                           | In git                   | Holds                                  |
| ---------------- | ------------------------------ | ------------------------ | -------------------------------------- |
| Project          | `.agentkit/tastes/`            | yes, in every clone      | what is true in this repository        |
| Project external | `.agentkit/tastes/external/`   | yes, a vendored snapshot | a source this repository subscribes to |
| User             | `~/.agentkit/tastes/`          | no, machine-local        | personal ergonomics, every project     |
| User external    | `~/.agentkit/tastes/external/` | no, machine-local        | a source this machine subscribes to    |
| Kit              | `rules/`                       | ships with agentkit      | universal engineering discipline       |

**One tree, two origins.** In either store, the owner's own tastes sit at the root of the
`tastes/` folder and a snapshot of each declared source sits beneath it in `external/`. They are
the same kind of file, read the same way, differing only in where they came from — which is why
they are one folder rather than two siblings implying two concepts.

`external` is therefore reserved at the root of a tastes tree: a taste or a category directory
of that name is refused by the lint, because that path is read by position and would be read
as a source. Everything else at the root is that store's own layer, and nothing under
`external/` is ever counted as one.

The external layer holds one directory per declared source, and only a declared one is read:
a directory under `tastes/external/` that no longer appears in `taste.sources` binds nothing,
and is named as vendored-but-undeclared rather than left to look active. The next section is
how a source gets there.

`rules/` is not a taste directory and is never written by this skill. It is the floor a
taste can override for one project.

## Two places to install a source

A source is a git repository whose files are tastes, and where you declare it
**decides where its snapshot lands**. That is the whole of the choice:

| Declared in                      | Snapshot lands in                   | Its lock                       | Read by                           |
| -------------------------------- | ----------------------------------- | ------------------------------ | --------------------------------- |
| `~/.config/agentkit/config.yaml` | `~/.agentkit/tastes/external/`      | `~/.agentkit/tastes.lock`      | every repository on this machine  |
| `<repo>/.agentkit/config.yaml`   | `<repo>/.agentkit/tastes/external/` | `<repo>/.agentkit/tastes.lock` | anyone who clones that repository |

**Which do I want?**

- **Machine-level**, when one owner works across many repositories and the policy is theirs
  rather than any repository's. Declare it once and every repository picks it up — nothing is
  copied into any of them, so nothing can leak into a public one. A private set belongs here.
- **Repository-level**, when the policy has to travel with the clone: a team whose members never
  configured their machines, a CI runner, an agent running in a container that is handed the
  repository and nothing else. The snapshot is committed, so a fresh checkout with no network
  is already carrying it.

**Both may be declared, and both apply.** Each vendors into its own store, so they cannot
collide and neither list replaces the other; the repository's sources simply resolve above the
machine's. Two stores means two locks — one file describing both would put a machine-local pin
in a repository's review surface, where nobody reviewing that repository can see what it is.

## External sources

An external source is an organisation's policy that every repository agrees on, kept in
one place instead of copy-pasted into each one. Subscribing is an
ordinary committed config change in `taste.sources`, reviewed like any other; nothing
arrives because a tool discovered it.

```yaml
taste:
  sources: # ordered — a later entry wins
    - repo: git@github.com:developerinlondon/agentkit-tastes.git
      ref: v2026.08.1
      mode: vendored # the default — the snapshot is committed to this repository
      visibility: public # required here — this snapshot is committed to this repository
      path: tastes/ # optional — the subdirectory that holds the taste files
      name: agentkit-tastes # optional — defaults to the repository's own name
    - repo: git@github.com:developerinlondon/business-tastes.git
      ref: v2026.08.4 # declared second, so it wins any name the set above also defines
      visibility: private # so this entry only vendors into a repository known to be private
```

- **Order is the precedence rule.** Two sources defining `release-tier` is the feature rather
  than a conflict: a later source wins, and the private central set is declared second
  precisely so it overrides the public generic one. Nothing else decides it — not a filename,
  not a date, not which one was synced most recently.
- **`mode: vendored` is the only mode that exists today.** The snapshot is committed to the
  store the source was declared for, so a fresh clone with no network — a plane, a CI runner
  with no credentials for your git host — already has the policy and reads it without
  fetching anything. `mode: reference`, the per-machine cache, is **deferred**: declaring it
  is an error naming the deferral, never a quiet fall back to vendoring something the owner
  did not ask to commit.
- **A `ref` is a plain branch, tag or commit name**, and one beginning with `-` is refused:
  git reads options after positionals, so a ref like `--upload-pack=…` is a program git would
  run rather than a revision it would fetch. The sync passes `--end-of-options` as well, so
  the refusal does not depend on the validator alone. A `repo` is a URL or a path for the same
  reason: git's `scheme::command` remote form runs a program instead of fetching, and is
  refused at the boundary and pinned off in the fetch.
- **`.agentkit/tastes.lock` pins each source to the commit whose contents were reviewed.** It
  is generated in `taste.sources` order and carries the name, repository, ref, commit and the
  date that pin was taken. The date moves only when the pin does.
- **Never edit `.agentkit/tastes/external/` by hand.** The next sync regenerates it wholesale,
  so an edit there is a change that quietly disappears. To change what a source says, change
  it in the source's own repository; to deviate in one repository, write a project taste of
  the same `name`, which wins outright and is visible in that repository's own diff.

### The guard on vendoring a private source

Vendoring **commits a source's words** into the repository you run it in. A private set — one
naming business repositories, hosts, handles or identities — committed into a public repository
is a leak, and this guard exists because that happened here: the rule against it was prose, and
prose does not stop a sync.

- **`visibility: public | private` is required of a source a repository vendors.** Missing is a
  refusal naming the key, never a default. At the machine level it is optional and defaults to
  `private`, because nothing declared there is copied into any repository.
- **A private source is refused entry to a public repository**, naming the source, the target
  and the reason. The target is read from its forge: `gh` for a GitHub remote, `glab` for a
  GitLab one.
- **The forge is asked about `origin` by name.** Asked without a repository, both CLIs resolve
  one from every remote by their own precedence — `gh` prefers `upstream` — so a checkout with a
  second remote would otherwise be judged by a repository nobody named, and the verdict pinned on
  the one that was read.
- **It fails closed.** A target whose visibility cannot be determined — no remote, no forge CLI,
  a CLI that errors, a host that is neither forge — is refused too. Assuming privacy on no
  evidence is the assumption that costs a leak; the other one costs a variable.
- **Internal is not private.** Every account on the instance can read an internal repository, so
  for this guard it sits on the public side of the line.
- **The machine level is gated only when it publishes.** Ordinarily nothing there reaches a forge
  and no check runs at all. When `~/.agentkit/tastes/` sits inside a git work tree —
  a dotfiles repository is the shape this exists for — it is a target like any other and is judged
  the same way. Machine sources default to `private`, so this refuses by default and says how to
  proceed: move the store out of the work tree, or declare the source `visibility: public`.
- **The override is `AGENTKIT_TASTE_TARGET_PRIVATE=1`** on the sync command. It supplies the one
  fact the tool could not establish — that this repository is private — and nothing else: a
  target the forge answered _public_ for stays refused with it set, because that case is the
  leak rather than the inconvenience. Empty, `0`, `false`, `no` and `off` are refusals here too.

## Loading

Do this before your first substantive action in a repository, not after.

1. List `.agentkit/tastes/` excluding `external/`, then `.agentkit/tastes/external/*/`, then
   `~/.agentkit/tastes/` excluding `external/`, then `~/.agentkit/tastes/external/*/`, recursing
   into category subdirectories.
2. Read the frontmatter of each file. Resolve by `name`: keep the copy from the highest
   scope, discard the rest. Two entries with one name is a replacement, not a conflict.
3. **A taste that loads, loads whole.** Never a summary, never a first sentence standing in
   for the rest of the file. A taste is a short file by construction, and a whole folder of
   them is a few thousand tokens — the cost that would justify abridging one is not there.
4. Note every taste at `enforce: check` and what it covers. You re-read those later.

### Why never a summary

A partial preference is worse than an absent one, because it is acted on with confidence.
The imperative fits on one line; the exceptions, the reason, and the how-to-apply do not,
and those are most of what a taste is for. An agent holding only the opening line cannot
know which of the three it is missing, so it does not know to go looking.

The alternative — hold a one-line summary, open the file when it matters — is a **prose
discipline**, and this repository already carries the evidence on those: _"Instructions alone
are demonstrably routed around: a working one-MR cap was bypassed eleven times by simply
never opening an MR."_ Tastes exist because standing instructions decay under load. Building
the taste system's own loading on "the agent will remember to open the file" would repeat,
at the core of the system, the failure the system was built to fix.

### Selecting, when the folder is large

Selection is **structural, not lossy**. Filtering decides which tastes load, and it never
decides how much of one loads:

- Filter by `category` against the work in front of you.
- **Regardless of category, always load** every taste at `enforce: check` or `enforce: block`,
  and every taste at `strength: require`. Those cost the most to miss, so they are never what
  a filter drops.

Say which tastes you loaded when asked, and say plainly that you filtered rather than letting
a short list imply the folder was small.

`enforce: block` is unaffected by any of this. The `taste-police` hook reads the taste files
off disk itself, in its own process, on the command it is judging; it never consults what a
session loaded. Filtering changes what an agent knows before it acts, never what stops it.

Honor a loaded taste as an instruction from the owner. A `require` taste is not something
to argue with; a `prefer` taste is a default you may depart from if you say why.

## Working the folder, without a command

Tastes are skill-driven, and there is no CLI. You are the interface: reading a directory of
small markdown files is something you already do, and a command would be a second way to say
what the files already say. Four requests come up, and each is a behaviour here.

### "Show me my tastes"

Resolve as under Loading, then present one row per name — the winner, never every file:

| Column     | What it holds                                                   |
| ---------- | --------------------------------------------------------------- |
| `name`     | the key everything resolves on                                  |
| `scope`    | the layer the winning file came from, all four named apart      |
| `source`   | for an external row, which declared source it was vendored from |
| `strength` | `prefer` or `require`                                           |
| `enforce`  | `advise`, `check`, or `block`                                   |
| shadowed   | the layers and sources holding a same-named file that lost      |

Name the shadowed layers explicitly. "Your project's `release-tier` is overriding the one in
your home directory" is usually the answer someone came for, and a table of winners alone
hides exactly the surprise they are chasing. Give the path of any row on request, and say
plainly when a folder is empty rather than presenting an empty table.

A file the lint refuses is **named in the listing as skipped**, with what the lint said —
never left out of it. The reasoning is `UNCHECKED`'s: a surface that goes quiet about what it
could not read reports the same thing as a folder that never held it, and the missing row is
usually the taste the question was about.

### "Add a taste: …"

A dictated taste is a first-class capture path, not a lesser one. It runs the same Learning
sequence below — dedupe first, route to the scope that owns it, write, lint, land through a
merge request for a project taste — with one difference: the preference is already stated, so
there is nothing to judge about whether a correction was worth keeping.

Ask for what dictation did not supply rather than inventing it: the **why**, the **how to
apply**, and where the preference came from. `provenance` is today's date and its origin,
never a guess. Leave `enforce` at `advise` unless the owner asked for more — the owner sets
enforcement, and a taste does not earn `block` by being dictated.

### "Sync my tastes"

Run the skill's own sync. There is nothing to install and no command on the PATH:

```sh
bun <skill-dir>/scripts/sync.ts
```

It fetches each declared source at its `ref`, **lints it before anything is copied** — a
source whose tastes the lint refuses is reported by name, with the offending files, and
nothing enters the tree — snapshots the taste files into that store's `tastes/external/<name>/`,
and rewrites that store's `tastes.lock`. Only those two paths are ever written, and a source
that is no longer declared has its vendored copy removed. Files that are not tastes stay
upstream: nothing executable ever crosses into your repository with the words. Re-running it
when no pin moved produces no diff at all.

**Run inside a repository it refreshes both scopes that apply**, reporting each separately —
the repository's sources into the repository, the machine's into your home directory. Run
anywhere else, only the machine scope has anything to do. A scope that declares no sources is
said to be empty rather than silently skipped, and nothing of it is written or swept.

Then land it the ordinary way — branch, merge request, review — and say what it is while you
do: **a lock bump is a merge request whose diff is the exact text your agents will start
reading.** Approving a version number instead of the words is approving nothing, and the
reason to vendor at all is that the words are sitting in the diff.

If the sync refuses, report what it said, unedited. A refused source is a source whose
tastes would otherwise be skipped one by one at read time, with nobody having agreed to any
of it.

### "Is this folder valid?"

Run the lint below and report what it says, unedited.

## The file format

Full contract and a worked example: `references/format.md`. In brief — frontmatter carries
`name` (kebab-case, identical to the filename stem), `scope`, `strength` (`prefer` or
`require`), `provenance` (a date and where it came from), optionally `category`, `enforce`,
and a `rule` block. The body states the preference, then **why**, then **how to apply**.

Validate any folder you touched:

```sh
bun <skill-dir>/scripts/lint.ts .agentkit/tastes
```

`.agentkit/tastes/` can be handed over whole: the repository's own tastes are one scope and
each source under `external/` is linted as its own, so a name two sources both define stays the
stacking it is rather than a collision. A tree still at the old `.agentkit/tastes-vendor/` path
is read the same way, for one release of grace.

## What `enforce` means today

`enforce` is the owner's setting, never a rank a taste earns by being violated.

| Value    | What happens                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advise` | The default. The taste is loaded at session start and read. Most tastes stay here.                                                                              |
| `check`  | Re-read the taste's body immediately before an action it covers — a tag, a commit, a merge request — instead of trusting that an hour-old instruction survived. |
| `block`  | A generic `taste-police` hook refuses a matching command using this taste's own `remedy` and `override`.                                                        |

`block` is carried out by one generic hook — `taste-police`, in the core kit, on every harness
agentkit installs to. It resolves the same folders this skill does, takes the tastes at
`enforce: block` whose `rule` the lint accepts, and runs that rule's kind against the command in
process. Nothing in a taste is ever executed. Adding a blocking taste changes no code
anywhere: it is a file.

### What a rule can check: the kinds

**The enforcement vocabulary is extensible by agentkit and parameterised by tastes.** A
`rule.kind` names a check agentkit implements; the taste supplies the data it runs on and the
words it refuses with. The taste never carries the code, which is the whole reason a taste from
somewhere else is safe to load: **a hostile source can at worst over-block you**, because
picking a check and wording a refusal is all a taste can do.

| `kind`             | The taste supplies                     | agentkit inspects                     |
| ------------------ | -------------------------------------- | ------------------------------------- |
| `command`          | `match`, a regular expression          | the text of the command about to run  |
| `git-tag-sequence` | `policy`, one of three named orderings | the tags in the repository it runs in |

A preference that no kind can express stays at `enforce: check`. **A new kind is a change to
agentkit**, proposed and reviewed like one — never bespoke code smuggled into a taste folder.
`references/format.md` carries each kind's fields, the three tag policies, and worked examples.

**A kind this agentkit does not implement is skipped, loudly.** The lint refuses the file, and
the hook names it, warns, and keeps enforcing every other taste — a taste written against a
newer agentkit must not brick an older hook.

### What it does at the edges, so you can answer for it

- **Refusal** names the taste, its file, its own `remedy`, and its own `override`.
- **The override** is that taste's named variable, set inline on the command (`NAME=1 …`) or
  exported. Empty, `0`, `false`, `no` and `off` do not count — they warn and the taste still
  refuses, because a guard you can switch off by mistyping it is worse than none.
- **A malformed taste** is skipped with a warning and takes nothing else down with it. So is a
  pattern that outruns the match deadline — it is named, skipped, and the rest still bind.
- **An unrunnable hook** (no `bun`, no evaluator) says `UNCHECKED` and allows. It never
  refuses on its own uncertainty, and it never goes quiet where there were tastes to read.
- **A check that cannot read what it needs** says `UNCHECKED` for that one taste and allows the
  command — `git-tag-sequence` where git will not answer, for instance. Silence there would be
  worse than either verdict: the session would read enforcement into a guard that never ran.
- **Bounds**: `rule.match` is capped at 200 characters, only the first 4000 characters of a
  command are examined, and the match itself is abandoned after 250ms — length is not safety,
  since a short pattern can still backtrack forever. `references/format.md` carries the
  reasoning.

### Why this does not fail closed, when the vendoring guard does

The two guards sit on opposite sides of one question — what does the tool do when it cannot see?
— and they answer differently because **the cost of each mistake is different**:

- **Vendoring fails closed.** A private source wrongly let into a public repository is words
  published under someone's name, and no later commit takes them back. Refusing costs one
  environment variable.
- **A rule kind fails open, and says so.** Refusing every tag command in a repository whose tags
  cannot be read would cost real work, to prevent a mis-ordered tag that `git tag -d` undoes in
  a second. And **nothing to check is not a failure at all**: outside a git repository, or in one
  with no tags, `git-tag-sequence` passes silently, because there is no sequence to violate.

Do not "fix" this into symmetry. The rule is that a guard fails towards whichever error is
recoverable, and it is `UNCHECKED` — never a silent allow — whenever it could not look.

If someone asks why a `block` taste did not stop something, check those in order: the taste is
`advise`, the rule did not fire, the override was set, the file failed the lint, the kind is one
this agentkit does not implement, or the hook reported `UNCHECKED`.

Never raise `enforce` yourself. Observed violations are evidence for a proposal the owner
merges — the diff is how it changes.

## Learning: what to do when corrected, or asked

Learning is an event. It fires when a correction arrives or when a taste is dictated, and
never in the background. A dictated taste skips step 1 — the owner already decided it is
worth keeping — and runs every step after it unchanged.

**1. Is this a correction worth keeping?** It is, when the user says you did the wrong
thing for a reason that will hold next time. A bug you introduced is not a taste. A
one-sentence aside about this file is not a taste. "From now on", "always", "never", "I
told you last time" — those are.

**2. Dedupe before writing anything.** Search the loaded tastes by `name`, then by topic —
`git grep` the taste directories for the subject words. An update to the file that already
covers it beats a second file that half does. Two tastes that disagree must never both
exist, and the way that is guaranteed is that the second one is never written.

**3. If it contradicts a taste you already have, fork on intent.** These want opposite
things and tone will not tell you which:

- **One-off** — "make this one a minor". Use the taste's named `override` deliberately, or
  simply comply once. **The file is not touched.** The next occurrence goes back to the
  taste, because nothing changed.
- **Durable** — "from now on, minor". Supersede the taste **in place**: rewrite the body,
  adjust or remove the rule, bump `provenance` with today's date and what changed. Never a
  `release-tier-v2.md` beside it — git history is the archive, and reading the current
  preference must cost one file.

`strength` decides the ceremony:

- Contradicting a `require` taste — more so one at `enforce: block` — **ask outright**:
  _this contradicts `release-tier` — one-off, or change the taste?_ A policy that took a
  deliberate decision to set does not flip on one ambiguous sentence at the end of a long
  session.
- Contradicting a `prefer` taste — update it and say that you did.

**4. Route it to the scope that owns it.** A correction lands in whatever repository you
happened to be in; the preference usually is not about that repository. Writing it locally
is the fast path and the wrong one — it fixes this repo and leaves every other one wrong.

| When the correction…                              | It goes to                                                  | Scope    |
| ------------------------------------------------- | ----------------------------------------------------------- | -------- |
| names business repositories, hosts, or identities | the private central set — a merge request there             | external |
| is a stance any stranger could adopt              | a candidate for the public set — owner-approved, never auto | external |
| is true in this repository and no other           | a project taste, committed here                             | project  |
| is personal ergonomics rather than policy         | your own published set — the user layer                     | user     |
| is genuinely unclear                              | the private central set, as the safe default                | external |

Unsure defaults inward: a private taste that should have been public costs one promotion
merge request, while the reverse costs a leak. **Promotion to any public set is only ever
owner-approved.** Never publish a taste outward on your own judgment.

A correction that routes to a source is written **in that source's own repository**, not
copied into this one — a merge request there, and every subscriber picks it up at the lock
bump that follows. When you cannot reach that repository, say where the taste belongs, show
the file you would write, and ask whether to hold it as a project taste meanwhile. Do not
silently downgrade it into the wrong scope.

**5. Write it, then lint it.** Name it for the topic, kebab-case and unnumbered. State the
preference, then **why** it holds — an agent that knows the reason can tell a genuine
exception from a violation — then **how to apply** it at the moment it matters. Set
`strength`; leave `enforce` at `advise` unless the owner asked for more.

Then run `bun <skill-dir>/scripts/lint.ts` on every directory you touched, and fix what it
reports **before you show anyone the diff**. A taste that fails the lint is not written yet:
the folder is a dictionary something else reads, and at `enforce: block` an unlintable rule
is a refusal that never fires. This holds for every write — a correction, a dictated taste,
or an edit to one that already existed.

**6. Land it.** A project taste is an ordinary committed file: branch, merge request,
review — **never a direct commit to the default branch**, and never a file that exists only
on the machine that wrote it. A user taste is written straight to `~/.agentkit/tastes/`.
Then tell the user what changed, in one line, with the path.

## Hygiene

- **A taste is a topic, not a sentence.** The split test: would these clauses ever change
  independently? If yes, they are two tastes. If no, they are one taste with several
  clauses, however long it reads.
- **One file per taste, always.** A monolith that every new rule is appended to is the
  failure mode tastes exist to replace.
- **Category subdirectories** (`release/`, `git/`) once one flat listing stops being
  readable. Names stay unique across the whole tree.
- **Delete what is dead.** A superseded taste is rewritten; an obsolete one is removed. Git
  holds both.
- **A preference that cannot be written as a declarative rule stays at `check`.** It does
  not grow bespoke code, and nothing about a local preference ever changes agentkit itself.
