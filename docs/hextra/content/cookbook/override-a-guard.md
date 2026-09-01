---
title: Override a guard
weight: 6
---

Every police refusal names what to do instead, and where there is a legitimate exception it names
that too. Overrides are environment variables you prefix onto **one command** — never config you
set and forget.

```sh
# branch in a clone that has other worktrees (you know nobody else is in it)
AGENTKIT_ALLOW_SHARED_BRANCH=1 git checkout -b fix/x

# a second concurrent MR that is genuinely independent (GitLab; default limit is 1)
AGENTKIT_MR_POLICE_MAX=2 glab mr create …

# the user asked for npm specifically
AGENTKIT_ALLOW_PKG=1 npm ci

# a delegated workload you have decided to run directly
AGENTKIT_ALLOW_DELEGATED=1 docker build .
```

## The overrides

| Variable                           | Clears                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `AGENTKIT_ALLOW_SHARED_BRANCH=1`   | branching in a clone that has other worktrees                                                            |
| `AGENTKIT_ALLOW_BRANCH_STACKING=1` | cutting a branch off another feature branch                                                              |
| `AGENTKIT_ALLOW_STALE_PUSH=1`      | pushing a feature branch that is behind the default branch                                               |
| `AGENTKIT_MR_POLICE_MAX=<n>`       | the one-open-authored-MR limit                                                                           |
| `AGENTKIT_ALLOW_PKG=1`             | the bun-only rule (`npm`, `npx`, `yarn`, `pnpm`)                                                         |
| `AGENTKIT_ALLOW_DELEGATED=1`       | a _direct_ delegated command (`docker`, `ssh`, `systemctl`, …)                                           |
| `AGENTKIT_ALLOW_BARE_SVG=1`        | the figure-legibility lint on a published page                                                           |
| `AGENTKIT_SKIP_HOOKS=<names>`      | `coding-police`, `comment-police`, `prose-police`, `format-police`, `version-police` — by name, or `all` |

## Inline assignment counts

The refusing hooks read the variable **from the command text as well as the environment**, so
prefixing it on the command itself works:

```sh
AGENTKIT_ALLOW_PKG=1 npm ci     # the hook sees this and allows it
```

That is deliberate. An agent cannot export a variable into the harness's own environment, so
inline assignment is the only shape available to it — which is exactly the property you want,
because it makes each exception visible in the command that used it.

## What no override clears

**A spoofed runner.** `resource-police` trusts `bounded-run` by installed path, not by name.
`AGENTKIT_ALLOW_DELEGATED=1` explicitly does not clear that refusal — otherwise a shell function
called `bounded-run` could neuter every limit and the override would bless it.

**`bounded-run`'s own delegation check.** `AGENTKIT_ALLOW_DELEGATED=1` stops the police blocking a
direct `docker build`. It does not make `bounded-run -- docker build .` work; that still exits with
`docker delegates work outside the service cgroup`.

**The merge gate.** There is no override variable. A denied merge is fixed by re-reviewing the
current head, or by adding the head flag the denial names.

## Standing exemptions that are config, not overrides

Two things are genuinely per-repo policy rather than per-command exceptions, and live in
`~/.config/agentkit/config.yaml`:

```yaml
git-police:
  branch-protection:
    # repos where direct commits/pushes to main are fine — partial match on name
    allowed-repos:
      - my-notes

coding-police:
  # one-file-per-item collections that legitimately outgrow max-dir-files
  exclude-patterns:
    - routes/
    - migrations/
```

Repositories may override the `review` section in their own `.agentkit/config.yaml`. They cannot
weaken the merge policy that way — that comes from `.agentkit/review-policy.json` at the target
commit.
