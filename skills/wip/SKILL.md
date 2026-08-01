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
 BRANCH    feat/incidents-ui           0d    1 commits  !633 open
 BRANCH    fix/core-name-everywhere    7d    0 commits  no MR/PR ever opened
 ABANDONED feat/model-catalog-auto     5d   !492 closed without merging
 WORKTREE  wt/corename2                DIRTY 11 modified, 2 untracked — do NOT remove at ~/wt/corename2
 MR/PR     !628 (fix/voice)            held: no approving review
 FILED     #311 #312 — authored, open, unfixed
 DEFERRED  #313 — carved out of other work
 PLAN      plans/057.md                2 gap(s) unclosed
 MERGED    fix/old — merged on the forge; cleanup, not unfinished work
 NOTE      unrecognised forge host 'git.example.com' — merge requests and issues not checked
```

| Row         | Means                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| `BRANCH`    | an open change, or none ever opened, or state unknown                        |
| `ABANDONED` | a change closed without merging — a decision, not an oversight               |
| `WORKTREE`  | a checkout that still exists; `DIRTY` ones hold work no branch ref will save |
| `MR/PR`     | open and authored by you, with what stands between it and merging            |
| `FILED`     | issues you opened that are still open                                        |
| `DEFERRED`  | filed issues whose text says they were carved out of other work              |
| `PLAN`      | a plan whose gaps section lists work neither closed nor tracked              |
| `MERGED`    | merged on the forge — cleanup, not unfinished work                           |
| `NOTE`      | something that was **not** checked, and why                                  |

A `NOTE` row is the important one. An absent section means "nothing found";
a `NOTE` means "not looked at". They are never conflated, and a bounded list
always says how many entries it dropped.

## Never remove a DIRTY worktree

Uncommitted and untracked files die with the checkout, and the branch ref does
not carry them. Commit them, stash them, or leave the worktree alone.

## Whether a branch is finished is the forge's answer, not git's

A squash merge destroys the topological evidence by design: the squashed commit is not an ancestor
of the branch, and the merge base stays before the squash forever.

Measured against nine branches of known outcome, **every git-only rule reported all seven merged
ones as still outstanding**:

| Rule                                    | On a squash-merged branch                                       |
| --------------------------------------- | --------------------------------------------------------------- |
| `rev-list --count base..head`           | ahead forever — the squash is not an ancestor                   |
| `git diff base..head`                   | shows the default branch's own later commits as deletions       |
| `git diff base...head`                  | shows the branch's changes since the merge base — never empty   |
| `merge-tree --write-tree`, tree compare | correct on a small fixture, wrong once the default branch moves |

The last row is the trap: it passes a two-commit fixture and fails on a real repository, because a
fixture whose default branch has not moved cannot distinguish the case it exists to prove.

So `wip` asks the forge, and distinguishes four answers that mean different things:

- **merged** — cleanup, not unfinished work
- **closed without merging** — deliberately abandoned, which reads differently from forgotten
- **open** — in flight
- **no change ever opened** — the genuinely interesting one

**When the forge cannot answer, it says so and stops.** There is no local rule to fall back to, and
guessing loudly in the alarming direction is how a tool like this gets ignored.

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
