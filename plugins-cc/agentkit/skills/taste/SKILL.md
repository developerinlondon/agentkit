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
deleted, and the same `name` at a higher scope replaces the lower one outright.

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

Precedence is **project > external > user > kit**. The higher scope replaces the lower one
for the same `name` — two tastes are never merged into a third nobody wrote.

| Layer    | Path                       | In git                   | Holds                              |
| -------- | -------------------------- | ------------------------ | ---------------------------------- |
| Project  | `.agentkit/tastes/`        | yes, in every clone      | what is true in this repository    |
| External | `.agentkit/tastes-vendor/` | yes, a vendored snapshot | a taste repo you subscribe to      |
| User     | `~/.agentkit/tastes/`      | no, machine-local        | personal ergonomics, every project |
| Kit      | `rules/`                   | ships with agentkit      | universal engineering discipline   |

The external layer is declared and vendored by config that lands in a later phase; until
then the directory is simply absent, and it costs nothing to look for it and find nothing.

`rules/` is not a taste directory and is never written by this skill. It is the floor a
taste can override for one project.

## Loading

Do this before your first substantive action in a repository, not after.

1. List `.agentkit/tastes/`, `.agentkit/tastes-vendor/*/`, and `~/.agentkit/tastes/`,
   recursing into category subdirectories.
2. Read the frontmatter of each file. Resolve by `name`: keep the copy from the highest
   scope, discard the rest. Two entries with one name is a replacement, not a conflict.
3. Load the **body** of every `require` taste, and of every taste whose `category` touches
   what you are about to do. For a large set, frontmatter alone is the index — pull a body
   when the work reaches it, and say which tastes you loaded if asked.
4. Note every taste at `enforce: check` and what it covers. You re-read those later.

Honor a loaded taste as an instruction from the owner. A `require` taste is not something
to argue with; a `prefer` taste is a default you may depart from if you say why.

## Working the folder, without a command

Tastes are skill-driven, and there is no CLI. You are the interface: reading a directory of
small markdown files is something you already do, and a command would be a second way to say
what the files already say. Three requests come up, and each is a behaviour here.

### "Show me my tastes"

Resolve as under Loading, then present one row per name — the winner, never every file:

| Column     | What it holds                                                    |
| ---------- | ---------------------------------------------------------------- |
| `name`     | the key everything resolves on                                   |
| `scope`    | the layer the winning file came from: project, external, or user |
| `strength` | `prefer` or `require`                                            |
| `enforce`  | `advise`, `check`, or `block`                                    |
| shadowed   | the layers holding a same-named file that lost, or nothing       |

Name the shadowed layers explicitly. "Your project's `release-tier` is overriding the one in
your home directory" is usually the answer someone came for, and a table of winners alone
hides exactly the surprise they are chasing. Give the path of any row on request, and say
plainly when a folder is empty rather than presenting an empty table.

### "Add a taste: …"

A dictated taste is a first-class capture path, not a lesser one. It runs the same Learning
sequence below — dedupe first, route to the scope that owns it, write, lint, land through a
merge request for a project taste — with one difference: the preference is already stated, so
there is nothing to judge about whether a correction was worth keeping.

Ask for what dictation did not supply rather than inventing it: the **why**, the **how to
apply**, and where the preference came from. `provenance` is today's date and its origin,
never a guess. Leave `enforce` at `advise` unless the owner asked for more — the owner sets
enforcement, and a taste does not earn `block` by being dictated.

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

## What `enforce` means today

`enforce` is the owner's setting, never a rank a taste earns by being violated.

| Value    | What happens                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advise` | The default. The taste is loaded at session start and read. Most tastes stay here.                                                                              |
| `check`  | Re-read the taste's body immediately before an action it covers — a tag, a commit, a merge request — instead of trusting that an hour-old instruction survived. |
| `block`  | A generic `taste-police` hook refuses a matching command using this taste's own `remedy` and `override`.                                                        |

`block` is carried out by one generic hook — `taste-police`, in the core kit, on every harness
agentkit installs to. It resolves the same folders this skill does, takes the tastes at
`enforce: block` whose `rule` the lint accepts, and tests `rule.match` against the command in
process. Nothing in a taste is ever executed. Adding a blocking taste changes no code
anywhere: it is a file.

What it does at the edges, so you can answer for it:

- **Refusal** names the taste, its file, its own `remedy`, and its own `override`.
- **The override** is that taste's named variable, set inline on the command (`NAME=1 …`) or
  exported. Empty, `0`, `false`, `no` and `off` do not count — they warn and the taste still
  refuses, because a guard you can switch off by mistyping it is worse than none.
- **A malformed taste** is skipped with a warning and takes nothing else down with it.
- **An unrunnable hook** (no `bun`, no evaluator) says `UNCHECKED` and allows. It never
  refuses on its own uncertainty, and it never goes quiet where there were tastes to read.
- **Bounds**: `rule.match` is capped at 200 characters and only the first 4000 characters of a
  command are examined. `references/format.md` carries the reasoning.

If someone asks why a `block` taste did not stop something, check those in order: the taste is
`advise`, the pattern did not match, the override was set, the file failed the lint, or the
hook reported `UNCHECKED`.

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

Until the external layer ships, a correction that routes there cannot be written for the
owner. Say where it belongs, show the file you would write, and ask whether to hold it as a
project taste meanwhile. Do not silently downgrade it into the wrong scope.

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
