---
name: wip
description: >-
  Report what was started and not finished in a repository — unmerged branches,
  dirty worktrees, open merge requests and what holds them, open issues you
  filed, and plans whose own gaps section still lists untracked work. Read-only;
  it changes nothing. Use when asked "what is half done", "what did I leave
  unfinished", "what is still open", "status of my work", "anything abandoned",
  before picking up work after a break, and before calling a plan finished.
---

# wip

Answers one question — _what did I start and not finish?_ — from the repository
rather than from an agent's recollection of what it did.

```
wip                       # this repository
wip ~/code/a ~/code/b     # several, one block each
wip --limit 0             # no bounding
wip --no-forge            # git and plans only, no network
```

## Reading the output

```
neutron — 9 half-done
 BRANCH    fix/voice-truncate-275    5d    3 commits  no MR/PR
 WORKTREE  wt/corename2              DIRTY 11 modified, 2 untracked — do NOT remove at ~/wt/corename2
 MR/PR     !628 (fix/voice)          held: no approving review
 FILED     #311 #312 — authored, open, unfixed
 DEFERRED  #313 — carved out of other work
 PLAN      plans/057.md              2 gap(s) unclosed
 MERGED    fix/old — content already on main; safe to delete
 NOTE      unrecognised forge host 'git.example.com' — merge requests and issues not checked
```

| Row        | Means                                                                        |
| ---------- | ---------------------------------------------------------------------------- |
| `BRANCH`   | content is not on the default branch yet                                     |
| `WORKTREE` | a checkout that still exists; `DIRTY` ones hold work no branch ref will save |
| `MR/PR`    | open and authored by you, with what stands between it and merging            |
| `FILED`    | issues you opened that are still open                                        |
| `DEFERRED` | filed issues whose text says they were carved out of other work              |
| `PLAN`     | a plan whose gaps section lists work that is neither closed nor tracked      |
| `MERGED`   | branches whose content already landed — cleanup, not work                    |
| `NOTE`     | something that was **not** checked, and why                                  |

A `NOTE` row is the important one. An absent section means "nothing found";
a `NOTE` means "not looked at". They are never conflated, and a bounded list
always says how many entries it dropped.

## Never remove a DIRTY worktree

Uncommitted and untracked files die with the checkout, and the branch ref does
not carry them. Commit them, stash them, or leave the worktree alone.

## Why merged-ness is not counted by commits

`git rev-list --count origin/main..branch` calls a branch ahead **forever** in a
squash-merge repository — the squashed commit is not an ancestor of anything.
Trusting it invents abandoned work that does not exist. Two other rules fail as
well, both verified against a squash-merge fixture rather than assumed:

| Rule                          | Fails because                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `rev-list --count base..head` | a squashed branch is ahead forever                                                                                     |
| `git diff base..head`         | the default branch's own later commits appear as deletions on yours                                                    |
| `git diff base...head`        | answers a different question — the branch's changes since the merge base, non-empty for every branch that did anything |

`wip` merges the branch into the default branch in memory and asks whether the
result differs from the default branch. Nothing else survives a squash merge.

## Plans: when a plan may be called done

A plan's gaps section is the most honest record of what is outstanding. A gap
stops blocking when the author does one of two things they would do anyway:

- **tick it** — `- [x] …`, or strike it through (`- ~~no longer applies~~`)
- **name the issue that carries it** — `#123`, `!123`, or an issue/MR/PR URL,
  on the gap's own line or a sub-bullet under it

A bare bullet with neither is what the gate refuses: work stated in the plan,
with nothing anywhere that will bring it back.

```
plan-gate                       # every plan under this repository
plan-gate --all --tsv           # machine-readable, closed and tracked included
plan-gate --require-done        # only judge plans that claim to be done
```

`plan-police` runs the same checker on every edit that marks a plan done, and
refuses the edit while such a gap stands. Filing the issue and pasting its number
is the fix; `AGENTKIT_SKIP_HOOKS=plan-police` records a deliberate exception.

## Configuration

Plan layout varies, so nothing about it is hardcoded. Defaults are `plans/`,
`docs/plans/`, `doc/plans/`, `.omc/plans/`, `PLAN.md` and `PLANS.md`, and a
`wip:` section in `~/.config/agentkit/config.yaml` — or the repository's own
`.agentkit/config.yaml`, which wins — replaces them.

```yaml
wip:
  plan-paths:
    - design/decisions
  gap-headings: "known gaps|loose ends|snags"
  done-markers: "^[[:space:]]*status[[:space:]]*:[[:space:]]*(done|shipped)"
  issue-refs: "#[0-9]+|![0-9]+|[A-Z][A-Z0-9]+-[0-9]+"
```

`issue-refs` is where a Jira shop adds `PROJ-123`. It is not on by default:
nothing distinguishes a Jira key from a hex digest or a UTF-8 label, and a false
"tracked" loses the gap silently — the one direction this tool must not fail in.

## Forges

GitHub and GitLab both work, resolved per repository from its `origin` host —
including self-hosted instances, via `gh auth status` and the GitLab version
endpoint. A repository with neither CLI still reports branches, worktrees and
plans, and says in a `NOTE` what it could not check.
