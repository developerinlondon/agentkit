---
title: Environment variables
weight: 4
---

Every variable agentkit reads, grouped by what it is for. Variables in the first group are the ones
you set deliberately on a single command; everything below is installer input or test scaffolding.

{{< callout type="info" >}}
An override is set **inline on one command** (`NAME=1 some-command`), never exported into a shell
profile. Consent is recorded per invocation, and a variable exported once is consent you forgot you
gave.
{{< /callout >}}

## Per-command overrides

| Variable                           | Clears                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `AGENTKIT_ALLOW_PKG=1`             | `pkg-police` — a package-manager command the project's lockfile disagrees with                               |
| `AGENTKIT_ALLOW_DELEGATED=1`       | `resource-police`'s delegated-workload refusal. **Does not** clear the installed-path check on `bounded-run` |
| `AGENTKIT_ALLOW_SHARED_BRANCH=1`   | `git-police` — creating a branch in a clone that has other worktrees                                         |
| `AGENTKIT_ALLOW_BRANCH_STACKING=1` | `git-police` — cutting a branch from another feature branch                                                  |
| `AGENTKIT_ALLOW_STALE_PUSH=1`      | `git-police` — pushing a branch behind its default branch                                                    |
| `AGENTKIT_ALLOW_BARE_SVG=1`        | `pages-police` — publishing a diagram outside a figure island                                                |
| `AGENTKIT_BRANCH_WIP_MAX=<n>`      | raises `git-police`'s cap on open unfinished branches                                                        |
| `AGENTKIT_MR_POLICE_MAX=<n>`       | raises `mr-police`'s cap on open authored merge requests                                                     |
| `AGENTKIT_SKIP_HOOKS=<unit>,…`     | short-circuits the named advisory units, or `all`                                                            |
| `AGENTKIT_TASTE_TARGET_PRIVATE=1`  | permits vendoring a private taste source into a target that would otherwise refuse                           |

A unit's own override is named **inside its refusal message**. If a message does not name one, the
unit deliberately has none.

## Install-time inputs

| Variable                   | Default                 | Effect                                                      |
| -------------------------- | ----------------------- | ----------------------------------------------------------- |
| `AGENTKIT_HOME`            | `~/.agentkit`           | where the canonical copy lives                              |
| `CODEX_HOME`               | `~/.codex`              | the Codex tree the installer writes                         |
| `AGENTKIT_PLATFORM`        | from `uname -s`         | `linux`, `darwin` or `unknown`; anything else is rejected   |
| `AGENTKIT_SKIP_PROMPT`     | unset                   | suppresses the interactive kit picker                       |
| `CI`                       | unset                   | any value suppresses the picker                             |
| `AGENTKIT_SKIP_SKILL_DEPS` | unset                   | skip `bun install` inside skills that ship a `package.json` |
| `XDG_CONFIG_HOME`          | `~/.config`             | moves the config file and the systemd user unit             |
| `XDG_DATA_HOME`            | `~/.local/share`        | moves the session-shim directory                            |
| `AGENTKIT_SRC`             | `~/.agentkit-src`       | where `bootstrap.sh` clones the source                      |
| `AGENTKIT_REF`             | the newest `vX.Y.Z` tag | the ref `bootstrap.sh` installs                             |
| `AGENTKIT_REPO_URL`        | the public repo         | the clone source for `bootstrap.sh`                         |

## Runtime configuration

| Variable                                                         | Read by                                 | Effect                                                    |
| ---------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `AGENTKIT_CONFIG`                                                | the hooks                               | path to `config.yaml`, overriding the XDG lookup          |
| `AGENTKIT_REVIEW_PROFILE`                                        | `review-profile`                        | forces a profile instead of resolving one                 |
| `AGENTKIT_FORGE_KIND`, `AGENTKIT_FORGE_HOST`                     | the review gate, `git-police`           | pins forge detection when it cannot be inferred           |
| `AGENTKIT_RELEASE_TIER`                                          | the release flow                        | selects the tier for a release                            |
| `AGENTKIT_PAGES_ENDPOINT`                                        | `publish.ts`                            | the Pages API origin                                      |
| `AGENTKIT_PAGES_REPO`                                            | `publish.ts`                            | the canonical clone to render themes from and commit into |
| `AGENTKIT_CHROMIUM`                                              | the diagram renderer, page verification | the browser binary to drive                               |
| `AGENTKIT_DIAGRAM_VENDOR_PACKS`, `AGENTKIT_DIAGRAM_VENDOR_ICONS` | the diagram skill                       | where fetched vendor icon packs live                      |
| `AGENTKIT_SESSION_SCOPE`, `AGENTKIT_SESSION_CONF`                | `agent-session`                         | the systemd scope and its configuration                   |
| `AGENTKIT_RUN_ACTIVE`                                            | `bounded-run`                           | set inside a bounded run; a nested one is refused         |

## Test and internal

`AGENTKIT_RUN_INTEGRATION`, `AGENTKIT_TEST_CONCURRENCY`, `AGENTKIT_DIAGRAM_TEST_LIMITS`,
`AGENTKIT_DIAGRAM_ALLOW_LOCAL_PACKS`, `AGENTKIT_TASTE_SCRIPTS`, `AGENTKIT_TAG_SEQUENCE`,
`AGENTKIT_UPDATE_REMOTE`, `AGENTKIT_REPO`, `AGENTKIT_RAW_INPUT`, `AGENTKIT_HOOK_TARGET`,
`AGENTKIT_CODEX_HOOKS_ROOT__`.

These belong to the suite and the installer's own bookkeeping. `AGENTKIT_HOOK_TARGET=codex` is the
tag the uninstaller uses to recognise its own entries in Codex's `hooks.json`; `AGENTKIT_RAW_INPUT`
is the shared hook helper's internal buffer.

{{< callout type="warning" >}}
`bounded-run` scrubs custom environment variables from the command it runs. Pass data through argv
or a file, not through the environment, when a command has to run bounded.
{{< /callout >}}
