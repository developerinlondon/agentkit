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

| `kind`             | Its own keys                                       | What it inspects                               |
| ------------------ | -------------------------------------------------- | ---------------------------------------------- |
| `command`          | `match` (required)                                 | the text of the command about to run           |
| `git-tag-sequence` | `policy` (required), `match` (no)                  | the tags in the repository the command runs in |
| `judgment`         | `question` (required), `on` (no), `threshold` (no) | the change the command is about to make        |

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

### `kind: judgment`

Refuses a change a **prose** convention says it should not, by asking one typed question of a
System One model. It is the kind for a taste whose rule no regular expression can express —
"done means deployed", "no stopgaps", "one concern per commit" — which is most of them.

`question` is the yes/no the model answers, at most 500 characters and held to the same
no-backtick, no-`$()` bound as `remedy`. It is sent as structured instructions alongside the
**taste's own body**, so the criteria are the why and the how-to-apply the owner already wrote:
the question narrows what is being asked, the body says what good looks like.

`on` chooses which command shape the rule judges. Anything else passes without a call:

| `on`            | Judges                                  | The diff it reads                                 |
| --------------- | --------------------------------------- | ------------------------------------------------- |
| `commit`        | a tokenised `git commit`, the default   | `git diff --cached`, or `git diff HEAD` with `-a` |
| `merge-request` | `gh pr create` or `glab mr create`      | `git diff <default-branch>...HEAD`                |
| `any`           | every command, judged on its text alone | none                                              |

**The repository judged is the one the command targets.** A `git -C <dir> commit` is read in
`<dir>`, resolved against the directory the command runs in. Where the command moves the tree
out from under that reading — a `cd` or `pushd` before the commit, its own `--git-dir` or
`--work-tree` — the rule reports `UNCHECKED` rather than judging whichever repository the hook
happened to be invoked in. A commit inside a subshell is still a commit: `(git commit …)` is
judged, and `(cd sub && git commit …)` is `UNCHECKED`.

A wrapped command is read as the command it spells out. `bash -c 'git commit -m "x"'`,
`sh -c` and `eval` with a literal argument are tokenised and judged exactly as the same command
without the quotes, `-C` and `cd` included. Only text a shell would build at run time —
`bash -c "$CMD"`, a substitution, a variable spliced into the message — is genuinely out of
sight, and that is `UNCHECKED` naming the wrapper. A wrapped command that never commits stays
silent, because a notice on every wrapped call an agent makes is a notice nobody reads.

An amend is the one commit judged with an empty diff. `git commit --amend -m …` with nothing
staged changes only the message, and the message is what a taste about commit messages reads.

`threshold` is the probability at or above which the rule fires, defaulting to `0.75`. The model
returns a probability; **the threshold is agentkit's and the taste's, never the model's** — which
is what keeps the policy in a file you can read and change without a model call.

**The change leaves your machine.** The state sent is `{command, message, diff}`: the text of the
command, the message its own `-m` arguments carry, capped at 2 000 characters, and the diff,
capped at 12 000 characters, each with a note where it was cut. Those are POSTed to the provider
over TLS on every judged command. A repository whose diffs may not leave the building does not
get a `judgment` taste at `enforce: block`, and the caps bound the size of what travels, not
whether it travels.

`on: any` is the setting to be deliberate about: at `enforce: block` it is a network round trip
on **every** command the agent runs, `ls` included. Use it for a narrow, stated purpose, and
prefer `commit`, which is one round trip per commit.

**The provider needs a key, and agentkit works without one.** `TYPESAFE_API_KEY`, else the
trimmed contents of `~/.config/agentkit/typesafe-token`. The call is a single `POST` to
`/v1/systemone` (base URL from `TYPESAFE_BASE_URL`) with no retry: a vendor having a bad minute
must cost the session one deadline, not three.

**One budget covers every judgment in a command, not each one.** Five seconds for the whole
command, and at most four for any single call, shared by every `judgment` taste that runs on it.
A per-call deadline alone would not hold: `taste-police` runs its evaluator under a process cap,
three stalled tastes together would reach it, and an evaluator killed there writes nothing — so
**every** blocking taste goes unenforced, the `command` ones included. A taste reached after the
budget is spent reports `UNCHECKED` naming it, and the tastes after it keep enforcing.

It fails open, like every rule kind, and says so:

| Situation                                            | What happens                                          |
| ---------------------------------------------------- | ----------------------------------------------------- |
| the command is not the shape `on` names              | passes, and nothing is sent                           |
| a commit with an empty diff                          | passes — there is no change to judge                  |
| no key resolves                                      | **`UNCHECKED`**, naming both places to put one        |
| git cannot read the diff, or there is no repository  | **`UNCHECKED`**, naming what git said                 |
| the command moves the tree, or names its own git dir | **`UNCHECKED`**, naming which                         |
| HTTP 401, 422, 429, 5xx, or the deadline passes      | **`UNCHECKED`**, naming the status or the timeout     |
| the answer is not a probability between 0 and 1      | **`UNCHECKED`** — a malformed answer is not a verdict |
| the command's judgment budget is already spent       | **`UNCHECKED`**, naming the budget                    |

A taste at `enforce: block` whose key is absent is therefore a taste that reports itself
unenforced on every commit — loud, and never a silent pass.

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

And `.agentkit/tastes/no-stopgaps.md`, the kind whose rule is the taste's own prose:

```markdown
---
name: no-stopgaps
scope: project
category: engineering
strength: require
enforce: block
rule:
  kind: judgment
  question: Does this change ship a workaround that leaves the real fix for later?
  on: commit
  threshold: "0.75"
  remedy: Fix the cause, or say in the commit message why the workaround is the fix.
  override: AGENTKIT_ALLOW_STOPGAP
provenance: 2026-09-21 · session correction
---

Fix the cause. A workaround that leaves the real fix for later is not a fix.

Why: a stopgap is invisible the day after it ships, and the outage it defers
arrives without the context that would explain it.

How to apply: when the cause is out of reach, say so in the commit message and
file the follow-up — do not let the diff imply the problem is solved.
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
- **`AGENTKIT_TARGET_PRIVATE=1`** on the sync command asserts the one fact the tool could
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
