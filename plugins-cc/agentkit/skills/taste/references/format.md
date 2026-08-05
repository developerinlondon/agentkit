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
| `rule`       | no       | `kind` / `match` / `remedy` / `override`   | Only with `enforce: check` or `block`. Declarative data — never code |

No other top-level key is accepted. A typo is a rejection, not a silently ignored field.

`enforce` is the owner's setting, not a rank a taste earns by being violated. Repeated
violation is evidence for a proposal the owner merges — never an automatic promotion.

## The `rule` block

Present only when `enforce` is `check` or `block`. It is data the generic `taste-police` hook
reads; nothing in it is ever executed as a command.

| Key        | Required | Value                                                                   |
| ---------- | -------- | ----------------------------------------------------------------------- |
| `kind`     | yes      | `command` — the action class the pattern matches                        |
| `match`    | yes      | a regular expression that must compile                                  |
| `remedy`   | yes      | the sentence an agent is shown instead of the refused action            |
| `override` | no       | the name of one environment variable that lets it through, deliberately |

Every value is a string. No nesting, no lists, and no shell metacharacters — `override` is an
environment-variable name and nothing else. A preference no pattern can capture stays at
`enforce: check` rather than growing bespoke code.

**A remedy is plain prose.** It is a sentence an agent reads, never a command anything runs, so
name the command in words — `Cut a patch tag` rather than a backticked or `$()`-wrapped
fragment. Both `match` and `remedy` are refused if they carry a raw `` ` `` or `$(`.

A `match` may still pattern on those characters where it needs to: `\$\(` passes, because the
string then holds a backslash, a dollar, a backslash, and a paren — the literal sequence the
check looks for is not in it. A backtick has no such escape. It is a single character, so
`` \` `` still contains one, and a backtick therefore cannot appear in a `match` at all.

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
├── branch-naming.md      9 lines    require · advise
├── commit-identity.md   13 lines    require · check
├── mr-style.md          11 lines    prefer  · advise
└── release-tier.md      18 lines    require · block
```

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
