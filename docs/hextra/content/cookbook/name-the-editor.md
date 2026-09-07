---
title: Name the person at the keyboard
weight: 7
---

Several people share one agent session on one machine, so every commit carries the machine's
git identity and a wiki's "last edited by" can only ever say the machine. `editor-police` refuses
a commit in the repos you list until the session has said who is editing, and requires that
person on the commit as an `Edited-by` trailer. The `wiki-editor` skill asks the question once
per session.

Core kit; nothing extra to install. Inert until you list a repo.

## 1. Declare the roster and the repos

In `~/.config/agentkit/config.yaml`:

```yaml
editor-police:
  enabled: true
  repos:
    - myorg/*/wiki
  editors:
    ana: "Ana Example <ana@example.com>"
    bo: "Bo Example <bo@example.com>"
  fallback-email: team@example.com
```

`repos` are globs matched against the path of the repository a commit targets; the star does not
cross a `/`. `editors` maps the short name someone will answer with to the author string the
trailer carries. A name outside the map is recorded as typed, with `fallback-email`.

## 2. The first commit is refused with the question

The agent runs a commit in the wiki. The hook refuses, and the refusal tells the agent what to ask
and how to record the answer:

```text
EDITOR UNKNOWN (editor-police)
This commit is in a repo whose commits must name the person editing, and this session has not said who that is.
Ask the user with AskUserQuestion, one question: who is editing right now? Options: Ana Example, Bo Example, Other (type a name).
Record the answer once for this session:
  wiki-editor set <name> --session sess-4f2a
It prints the Edited-by line to use. Re-run the commit with that line written out in full:
  --trailer="Edited-by: Name <email>"
An unexpanded $(wiki-editor trailer ...) inside the commit is refused.
```

In Claude Code the agent puts that to you as a one-question choice, the roster plus **Other**:

```text
┌ Who is editing the wikis right now? ─────────────────┐
│ ● Ana Example                                        │
│ ○ Bo Example                                         │
│ ○ Other (type a name)                                │
└──────────────────────────────────────────────────────┘
```

## 3. The answer is recorded once

```sh
wiki-editor set ana --session sess-4f2a
```

```text
editor for this session: Ana Example
commit with: --trailer="Edited-by: Ana Example <ana@example.com>"
```

Case does not matter: `ana`, `Ana` and `ana example` all record the same person.

## 4. Every commit carries the person

Without the trailer, the refusal names the person and prints the exact flag:

```text
EDITOR NOT ON THE COMMIT (editor-police)
The person editing in this session: Ana Example <ana@example.com>
Add exactly this to the git commit that targets ~/repos/myorg/handbook/wiki:
  --trailer="Edited-by: Ana Example <ana@example.com>"
If someone else is editing now, first run: wiki-editor set <name> --session sess-4f2a
```

With it, the commit goes through and git records the trailer:

```sh
git commit -am "docs: fix the on-call page" --trailer="Edited-by: Ana Example <ana@example.com>"
git log -1 --format='%(trailers:key=Edited-by,valueonly)'
```

```text
Ana Example <ana@example.com>
```

The trailer must be written out. An unexpanded `$(wiki-editor trailer …)` is refused on purpose:
off `PATH` it substitutes to nothing, and git accepts an empty trailer without complaint.

## 5. Hand the keyboard over

Say who has taken over; the agent records it and the next commit must carry the new name:

```sh
wiki-editor set bo --session sess-4f2a
```

```text
editor for this session: Bo Example
commit with: --trailer="Edited-by: Bo Example <bo@example.com>"
```

A commit still carrying Ana's trailer is now refused with Bo's line in the remedy.

## Why a trailer and not `--author`

A squash merge rewrites the author and keeps the trailers. Read the merged commit back with
`git log --format='%(trailers:key=Edited-by,valueonly)'`, and pass the same line in the squash
message on a forge that lets you set one, or the merge commit loses it.

## What counts as the commit's repo

The command is tokenised with shell quoting honoured, so the repo is the one the commit targets:
`-C path`, `--git-dir`, `GIT_DIR=`, the working directory after any `cd`, `pushd` or `popd`, a
linked worktree of a listed clone, and a commit inside a `bash -c` string, `eval` or a command
substitution. A listed path inside a commit message, a heredoc body or a `# comment` is not a
target. Global git options in any order are seen; the words inside a quoted string are not.

## When it cannot judge, it refuses

| Refusal                    | Cause                                                     | Do                                            |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| `EDITOR UNKNOWN`           | nobody recorded for this session                          | ask, then `wiki-editor set`                   |
| `EDITOR NOT ON THE COMMIT` | trailer missing or another person's                       | add the printed `--trailer` flag              |
| `EDITOR TOOL MISSING`      | `wiki-editor` not installed                               | `./install.sh --global`, or `WIKI_EDITOR_BIN` |
| `EDITOR GATE UNCHECKED`    | `awk` or `jq` off `PATH`, or 1500+ statements in one call | fix `PATH`, or split the command              |

None of them are worked around with `-c user.name`, `--author` or `--no-verify`; the skill says so
and the hook does not read those.

## Off switches

| Scope   | How                                     |
| ------- | --------------------------------------- |
| session | `AGENTKIT_SKIP_HOOKS=editor-police`     |
| machine | `enabled: false` under `editor-police:` |
| nothing | leave `repos` empty; the hook is inert  |

Full keys in the [configuration reference](/reference/configuration/#editor-police); verbs and exit
codes in the [CLI reference](/reference/cli/#wiki-editor).
