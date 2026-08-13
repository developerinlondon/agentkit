# The taste file contract

One taste is one markdown file: YAML frontmatter an agent can filter on, and a body a human
wrote. The filename stem is the taste's identity — `release-tier.md` holds `name: release-tier`
— and that name is the key everything else uses: dedupe on capture, lookup at load, and
override across scopes.

## Frontmatter fields

| Field        | Required | Values                                     | What it changes                                                      |
| ------------ | -------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `name`       | yes      | kebab-case, identical to the filename stem | The identity used for dedupe and for scope resolution                |
| `scope`      | yes      | `project` \| `external` \| `user`          | Which directory it belongs in, and who it binds                      |
| `strength`   | yes      | `prefer` \| `require`                      | `prefer` is a default an agent may argue with; `require` is not      |
| `provenance` | yes      | a date and where it came from              | When the preference was stated, so a stale one is visible            |
| `category`   | no       | free text                                  | Lets a skill load only the tastes an action can touch                |
| `enforce`    | no       | `advise` \| `check` \| `block`             | How hard it binds. Defaults to `advise`, where most tastes stay      |
| `rule`       | no       | `kind` plus that kind's own fields         | Only with `enforce: check` or `block`. Declarative data — never code |

No other top-level key is accepted. A typo is a rejection, not a silently ignored field.

`enforce` is the owner's setting, not a rank a taste earns by being violated. Repeated
violation is evidence for a proposal the owner merges — never an automatic promotion.

## The `rule` block

Present only when `enforce` is `check` or `block`. It is data the generic `taste-police` hook
reads; nothing in it is ever executed as a command.

Three keys are the same in every rule:

| Key        | Required | Value                                                                   |
| ---------- | -------- | ----------------------------------------------------------------------- |
| `kind`     | yes      | which check agentkit runs — one of the registered kinds below           |
| `remedy`   | yes      | the sentence an agent is shown instead of the refused action            |
| `override` | no       | the name of one environment variable that lets it through, deliberately |

Every value is a string. No nesting, no lists, and no shell metacharacters — `override` is an
environment-variable name and nothing else.

### The rule-kind registry

A `kind` is a **named predicate agentkit implements**. The taste chooses which check runs and
supplies the data it needs; the code that inspects anything is always agentkit's. That is what
keeps a taste data rather than a program, and it is why the trust property holds: a hostile
source can pick a check and word a refusal, so at worst it over-blocks you — it can never run
anything.

| `kind`             | Its own keys                      | What it inspects                               |
| ------------------ | --------------------------------- | ---------------------------------------------- |
| `command`          | `match` (required)                | the text of the command about to run           |
| `git-tag-sequence` | `policy` (required), `match` (no) | the tags in the repository the command runs in |

A key belongs to one kind: `policy` inside a `command` rule is an unknown key, and the lint says
so naming what that kind does carry.

**An unknown kind is refused by the lint**, naming the kinds that exist — and the hook runs that
same lint as it loads the folder, so at enforcement time the file is **skipped with a warning
while every other taste keeps enforcing**, rather than taking the hook down with it. That is what
lets a taste vendored from a source running a newer agentkit be safe to load at all. Upgrade
agentkit, or keep the taste at `enforce: check` until you have.

A preference no registered kind can express stays at `enforce: check` rather than growing
bespoke code in someone's taste folder. A new kind is a change to agentkit, reviewed like one.

### `kind: command`

`match` is a regular expression tested against the command string — at most 200 characters, and
it must compile.

**A remedy is plain prose.** It is a sentence an agent reads, never a command anything runs, so
name the command in words — `Cut a patch tag` rather than a backticked or `$()`-wrapped
fragment. Both `match` and `remedy` are refused if they carry a raw `` ` `` or `$(`.

A `match` may still pattern on those characters where it needs to: `\$\(` passes, because the
string then holds a backslash, a dollar, a backslash, and a paren — the literal sequence the
check looks for is not in it. A backtick has no such escape. It is a single character, so
`` \` `` still contains one, and a backtick therefore cannot appear in a `match` at all.

### Two bounds, because a rule runs on every command

`taste-police` tests the pattern in-process against the command string; nothing is ever handed
to a shell. A regular expression can still be made to backtrack for longer than anyone will
wait, so the match is bounded three ways:

| Bound                | Value            | What happens at the edge                                         |
| -------------------- | ---------------- | ---------------------------------------------------------------- |
| `rule.match` length  | 200 characters   | The lint refuses the file, and the hook skips it with a warning  |
| the command examined | first 4000 chars | A pattern that would only match past that does not fire          |
| the match itself     | 250 milliseconds | The taste is skipped, by name, and every other taste still binds |

Length is not safety: `(a+)+$` is eight characters and doubles its work for every character
you feed it. That is why the match runs on a thread the hook can abandon — a pattern that
outruns the deadline is treated exactly like a malformed taste, named in a warning and left
unenforced, rather than taking the session down with it.

The subject bound is the honest trade: a command long enough to hit it is a script, and a
taste is not a way to audit one. Write the pattern against what an agent actually types.

### `kind: git-tag-sequence`

Refuses a release tag that does not follow the tags already in the repository. A pattern cannot
do this — the answer is not in the command string — which is what a named predicate is for.

`policy` names which sequence rule applies. All three ignore any tag that is not semver, in the
proposal and among the existing tags alike, because a tag with no version carries no order:

| `policy`               | Refuses                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `no-duplicate`         | a tag that already exists                                                        |
| `no-backwards-in-line` | that, plus a tag lower than the highest existing tag **sharing its major.minor** |
| `strict-successor`     | that, plus anything but the immediate next patch of the highest tag **overall**  |

`no-backwards-in-line` is the one that keeps maintenance possible: on a repository at `v0.7.11`,
`v0.6.5` is allowed because nothing on the `0.6` line is above it, while `v0.6.2` is refused
because `v0.6.5` already is. `strict-successor` refuses both — it is for a project that cuts one
line and nothing else. A prerelease sorts below the release it leads to, so `v0.8.0-rc1` then
`v0.8.0` is an ascending pair under every policy.

**`strict-successor` cannot open a new line, prerelease included.** On a repository at `v0.7.11`
it refuses `v0.8.0-rc1` exactly as it refuses `v0.8.0`, saying the next tag is `v0.7.12` — the
next patch is the only thing it accepts, and a release candidate for a new minor is not one.
That follows from the name, but it is worth knowing before a release rather than during one: a
project that cuts minor release candidates wants `no-backwards-in-line`, or the taste's own
override for the one tag that opens the line.

The proposed tag is read from the command in the shapes agentkit recognises: `git tag <tag>`,
`git push <remote> <tag>` (including `refs/tags/` and `<src>:<dst>` refspecs), and
`gh release create <tag>`. Listing, verifying and deleting are not proposals — `git tag --list`,
`git tag -d v1.2.3` and `git push --delete` all pass. Where that reading is wrong for your
workflow, `match` overrides it: **its first capture group is the tag**, and it is held to the
same 200-character, must-compile, no-substitution bounds as a `command` rule.

**It does not fail closed, and that is deliberate.** The vendoring guard refuses whatever it
cannot verify, because the error it prevents is a leak that cannot be undone. This one is a
convention guard, so the two errors are the other way round:

| Situation                             | What happens                                      |
| ------------------------------------- | ------------------------------------------------- |
| the command proposes no semver tag    | passes, and git is never run                      |
| the directory is not a git repository | passes silently — there is no sequence to violate |
| the repository has no tags            | passes silently — there is nothing to be behind   |
| git cannot be run, or cannot list     | **`UNCHECKED`, and the command is allowed**       |

Failing closed here would refuse every tag command in every repository whose tags cannot be
read, to prevent a mis-ordered tag that `git tag` itself makes trivial to delete. But a silent
allow would be worse than either: the session would read enforcement into a guard that never
ran. So it says `UNCHECKED`, names the taste and the reason, and lets the command through.

### What counts as using an override

The override is one environment variable name — the taste's own — and using it is a decision,
so it must look like one. `AGENTKIT_RELEASE_TIER=1` before the command, or the same variable
exported into the session, lets that one command through and nothing else.

Empty, `0`, `false`, `no` and `off` do not switch it on. A guard that can be disabled by
mistyping its escape hatch is worse than no guard, so those values warn and the taste still
refuses. Misspelling the variable's name simply leaves the override unset — also a refusal.

## A taste in full

`.agentkit/tastes/release-tier.md`, the file the release-tier correction produces:

```markdown
---
name: release-tier
scope: project
category: release
strength: require
enforce: block
rule:
  kind: command
  match: 'git tag .*\bv[0-9]+\.[0-9]+\.0\b'
  remedy: Cut a patch tag, or record the owner's agreement in the release PR first.
  override: AGENTKIT_RELEASE_TIER
provenance: 2026-08-05 · session correction
---

Cut patch releases by default. A minor or major tier needs the owner's explicit
agreement for that specific release.

Why: "publish this" authorizes a release, never the tier. An agent reasoning from
semver alone will tag a minor for any feature-shaped diff.

How to apply: propose the patch version in the release PR. If the diff looks
minor-worthy, say so and ask — do not tag it.
```

And `.agentkit/tastes/tag-sequence.md`, the same shape with the other kind — no pattern, because
what it checks is not in the command:

```markdown
---
name: tag-sequence
scope: project
category: release
strength: require
enforce: block
rule:
  kind: git-tag-sequence
  policy: no-backwards-in-line
  remedy: Read the tags first and cut the next patch on the line you are releasing.
  override: AGENTKIT_TAG_SEQUENCE
provenance: 2026-08-06 · issue 328
---

A release tag goes forwards on its own line. A lower line is maintenance and is
fine; a tag below one that already exists on the same line is not.

Why: version numbers are read as a sequence by everything downstream — a
backwards tag makes "latest" mean two different commits.

How to apply: list the tags before tagging. If the tag you want is already
there, or is behind one on its line, pick the next patch instead.
```

## The source contract

A source is declared in `brain.taste.sources`, in a repository's `.agentkit/config.yaml` or the
machine's `~/.config/agentkit/config.yaml`. Both lists apply and each vendors into its own store.

| Key          | Required                | Value                                                                   |
| ------------ | ----------------------- | ----------------------------------------------------------------------- |
| `repo`       | yes                     | a git URL or path — never git's `scheme::command` transport-helper form |
| `ref`        | yes                     | a plain branch, tag or commit; one beginning with `-` is a git option   |
| `visibility` | for a repository's list | `public` \| `private` — whether these words may be published            |
| `mode`       | no                      | `vendored`, the default and the only mode; `reference` is deferred      |
| `path`       | no                      | a relative subdirectory of the source that holds the taste files        |
| `name`       | no                      | the directory it vendors into; defaults to the repository's own name    |

`visibility` is what a vendoring is judged against, because vendoring **commits the source's
words** into the repository it runs in:

- **Required of a source a repository vendors.** Missing is a refusal naming the key. On the
  machine's list it is optional and defaults to `private`, since nothing there is committed
  anywhere.
- **`private` is refused entry to a public repository**, and refused just as firmly when the
  target's visibility cannot be read at all — no remote, no `gh` or `glab`, a forge that errors.
  A repository that cannot be shown to be private is treated as public.
- **`internal` on a forge is not private**: every account on that instance can read it.
- **The forge is asked about the URL of `origin`.** Asked without one, `gh` and `glab` resolve a
  repository from all remotes by their own precedence, which answers about a different repository
  than the one whose URL was read.
- **The machine's own store is judged too when it sits inside a git work tree** — a dotfiles
  repository. Outside one it publishes nothing and no check runs.
- **`AGENTKIT_TASTE_TARGET_PRIVATE=1`** on the sync command asserts the one fact the tool could
  not establish. It does not overrule a forge that answered, and empty, `0`, `false`, `no` and
  `off` do not switch it on.

## Body shape

Three parts, in this order. A taste missing the last two is a slogan: the agent that reads it
next has only the words on the page.

1. **The preference**, stated as an instruction. One or two sentences.
2. **Why** — the reason it holds, so an agent can tell a genuine exception from a violation.
3. **How to apply** — what to actually do at the moment the taste is relevant.

A body may carry several clauses when they always travel together. The test that decides a
split: would these clauses ever change independently? If yes, they are separate tastes.

## A taste folder

```text
.agentkit/tastes/
├── branch-naming.md            9 lines    require · advise
├── commit-identity.md         13 lines    require · check
├── mr-style.md                11 lines    prefer  · advise
├── release-tier.md            18 lines    require · block
└── external/                             snapshots of declared sources
    ├── agentkit-tastes/
    │   └── diagrams-over-prose.md
    └── business-tastes/
        └── release-tier.md               shadowed by the project file above
```

The files at the root are this repository's own. `external/` holds one directory per source
declared in `brain.taste.sources`, written only by the skill's sync — one tree with two origins, not
two folders. `external` is reserved for exactly that: a taste or a category directory of that
name is refused, because the path is read by position rather than by what it is called.

Kebab-case, and deliberately unnumbered. A taste folder is not an append-only record; it is a
living dictionary keyed by `name`, whose files get added, rewritten, and deleted. Ordering
would advertise a precedence that does not exist — what wins is decided by scope, never by
filename — and the same `name` appearing at two scopes is the feature that makes overriding
work.

Category subdirectories (`release/`, `git/`, `writing/`) are fine once one flat listing stops
being readable. Names stay unique across the whole tree: two files with the same `name` are a
collision even in different subdirectories, because the resolver keys on the name alone.

## Checking a folder

```sh
bun <skill-dir>/scripts/lint.ts .agentkit/tastes
```

It walks the directory tree, validates every `.md` file against the contract above, prints one
line per violation, and exits non-zero if there was any. Run it on a taste you hand-wrote, and
in CI on a repository whose `.agentkit/tastes/` is committed.

The root can be handed over whole. Names must be unique among the repository's own tastes and
unique within each source, but a name two sources both define is the stacking `brain.taste.sources`
exists for rather than a collision, so the run scopes dedupe accordingly instead of demanding
one invocation per directory.
