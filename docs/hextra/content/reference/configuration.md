---
title: Configuration
weight: 2
---

One file: `~/.config/agentkit/config.yaml`, seeded from `config.example.yaml` on the first install and
**never overwritten afterwards**. `XDG_CONFIG_HOME` is respected; `AGENTKIT_CONFIG` overrides the
path outright.

A repository may override parts of it in its own `.agentkit/config.yaml`. The asymmetry matters: a
repository can require **more** than the machine config, and never less.

| Scope         | File                                  | Wins on                                                  |
| ------------- | ------------------------------------- | -------------------------------------------------------- |
| machine       | `~/.config/agentkit/config.yaml`      | thresholds, defaults, which units are enabled            |
| repository    | `<repo>/.agentkit/config.yaml`        | `review`, `wip`, `brain` sections                        |
| target commit | `<repo>/.agentkit/review-policy.json` | the merge gate — cannot be weakened by either file above |

## `review`

Controls orchestration effort, not merge authority.

| Key                 | Values                       | Default          |
| ------------------- | ---------------------------- | ---------------- |
| `profile`           | `fast`, `balanced`, `strict` | `balanced`       |
| `primary-review`    | `nontrivial`, …              | from the profile |
| `specialist-review` | `critical`, …                | from the profile |
| `product-review`    | `triggered`, …               | from the profile |
| `ci-evidence`       | `reuse`, …                   | from the profile |
| `local-checks`      | `affected`, …                | from the profile |
| `evidence-note`     | `always`, …                  | from the profile |

Delete a granular key to inherit the selected profile.

| Profile    | Means                                                                                |
| ---------- | ------------------------------------------------------------------------------------ |
| `fast`     | primary review for non-trivial work; specialist and product only on narrow triggers  |
| `balanced` | one primary review by default; extra lanes for critical, user-facing or release work |
| `strict`   | primary, specialist and product lanes, full local checks, and CI reruns              |

## `git-police`

| Key                               | Type            | Default | Effect                                                                      |
| --------------------------------- | --------------- | ------- | --------------------------------------------------------------------------- |
| `branch-protection.allowed-repos` | list of strings | `[]`    | repositories where direct commits and pushes to `main`/`master` are allowed |

Entries match by repo name (`brain`) or `owner/name` (`myorg/brain`); partial matches are supported,
so `brain` matches `myorg/brain`.

## `issue-police`

Three refusals need no configuration, because they are wrong everywhere: an issue filed with **no
body at all**, one whose body still carries an **unfilled template** — a guidance comment, an
empty checkbox, or a bare quick action like `/milestone %` — and one whose `Disposition:` line is
not `in-progress`, `owner-deferred`, `owner-request`, or `blocked-by` with non-empty text. The rest is what only a
project can decide.

| Key                      | Type   | Default | Effect                                                           |
| ------------------------ | ------ | ------- | ---------------------------------------------------------------- |
| `min-body-chars`         | int    | `0`     | refuse a body shorter than this; `0` disables the floor          |
| `max-body-chars`         | int    | `0`     | refuse a body longer than this; `0` disables the ceiling         |
| `require`                | string | `""`    | comma-separated: `labels`, `assignee`, `milestone`               |
| `refuse-self-assignment` | bool   | `false` | refuse an issue assigned to the account whose token is filing it |

A required **label** is additionally checked against the project's own taxonomy, because a label the
project does not define is dropped on creation — the item lands unlabelled while the command that
filed it looks correct.

`refuse-self-assignment` is off by default because only the operator knows which case they are in:
an agent driving a person's own credentials assigns to that person legitimately, while a bot
assigning to itself produces an item that looks owned and is not.

## `mr-police`

| Key                       | Type | Default | Effect                                                             |
| ------------------------- | ---- | ------- | ------------------------------------------------------------------ |
| `require-issue-reference` | bool | `false` | refuse a merge request whose body names no issue                   |
| `forbid-closing-keywords` | bool | `false` | refuse `close`/`fix`/`resolve`/`implement` next to an issue number |

The open-MR cap is separate and set by `AGENTKIT_MR_POLICE_MAX` in the environment, not here.

`forbid-closing-keywords` stays off by default because auto-close is the behaviour most projects
want. Turn it on where completion is the requester's call to make after verifying, not the merge's.

### The forge lookups are cached

Checking a label against a taxonomy, or an assignee against the token's own identity, needs the
forge. Those answers are cached under `$XDG_CACHE_HOME/agentkit/forge` — identity for a day,
taxonomies for an hour — and the cache can only ever cost a wasted refresh, never a wrong refusal:
a cached answer that would **pass** is trusted, and one that would **deny** is refetched before
anything is refused. With no CLI installed, or a forge that cannot be reached, both units fail open.

## `coding-police`

| Key                    | Type | Default | Effect                                                                                             |
| ---------------------- | ---- | ------- | -------------------------------------------------------------------------------------------------- |
| `max-file-lines`       | int  | `1000`  | lines per file before it warns to split                                                            |
| `max-function-lines`   | int  | `100`   | lines per function before it warns to decompose                                                    |
| `min-duplicate-lines`  | int  | `6`     | identical consecutive lines flagged as duplication                                                 |
| `max-exports-per-file` | int  | `15`    | exports per file before a single-responsibility warning                                            |
| `max-dir-files`        | int  | `15`    | source files in one directory; `0` disables. Only fires when a Write **creates** a new source file |
| `exclude-patterns`     | list | `[]`    | path patterns excluded from all checks                                                             |

`exclude-patterns` exists for homogeneous one-file-per-item collections — `routes/`, `migrations/`,
`__snapshots__/` — that legitimately outgrow `max-dir-files` without being a mixed-concerns monolith.

## `pkg-police`

| Key       | Values                                      | Default |
| --------- | ------------------------------------------- | ------- |
| `manager` | `auto`, `bun`, `npm`, `pnpm`, `yarn`, `off` | `auto`  |

`auto` infers from the lockfile: `bun.lock`/`bun.lockb` → bun, `package-lock.json` → npm,
`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn. **No lockfile, or several that disagree, means there is
no basis to judge and nothing is blocked.**

An unrecognised name disables the unit. Quoting the value is fine — `manager: "bun"` reads as bun
rather than as an unrecognised value that silently switches the unit off.

Every command belonging to another manager is blocked, as is every subcommand that writes
`package.json`, `node_modules` or the lockfile. Read-only queries such as `npm ls` are left alone.
`AGENTKIT_ALLOW_PKG=1` overrides a single command regardless of this setting.

## `resource-police`

| Key       | Type                | Default           |
| --------- | ------------------- | ----------------- |
| `enabled` | bool                | `false`           |
| `bounded` | list of class names | all eight classes |

{{< callout type="warning" >}}
**Off by default.** Nothing is bounded anywhere, and the Codex resource policy is not installed. The
value must be the literal `true` to enable. Claude Code and OpenCode honour a change immediately;
Codex policies update on the next `install.sh` run.
{{< /callout >}}

Classes: `js-packages`, `js-scripts`, `typescript`, `playwright`, `cargo`, `go`, `moon`, `python`.
Remove entries to relax individual classes; omitting the whole list bounds every class. See
[containment](/guide/concepts/containment/).

## `delegation-police`

| Key       | Type | Default |
| --------- | ---- | ------- |
| `enabled` | bool | `false` |

Off by default: nothing is blocked, and the Codex policy file is not installed. When enabled it
refuses delegated and privileged workloads — `ssh`, `sudo`, `ansible`, container engines, service
managers, `kubectl` mutations — outside engine-native limits. Read-only diagnostics are always
allowed even when enabled.

## `version-police`

| Key          | Type | Default |
| ------------ | ---- | ------- |
| `enabled`    | bool | `true`  |
| `exceptions` | list | `[]`    |

`exceptions` takes exact names or `*` globs and applies to every manifest, including `package.json`,
which has no comments to record a deliberate pin in.

## `comment-police`

| Key                  | Type          | Default      |
| -------------------- | ------------- | ------------ |
| `max-block-lines`    | int           | `6`          |
| `max-header-lines`   | int           | `10`         |
| `max-comment-ratio`  | float         | `0.3`        |
| `forbidden-patterns` | list of regex | six patterns |
| `exclude-patterns`   | list          | `[]`         |

The shipped `forbidden-patterns` catch references that rot: `Plan-?\d+`, `PR\s*#?\d+`,
`closes\s*#\d+`, `fixes\s*#\d+`, `TODO[: ]+(for|after|once)\b`, and
`as part of (this|the) (PR|MR|fix)`.

## `prose-police`

| Key                         | Type | Default |
| --------------------------- | ---- | ------- |
| `enabled`                   | bool | `true`  |
| `max-em-dash-per-100-words` | int  | `3`     |
| `exclude-patterns`          | list | `[]`    |

Flags AI writing tells in the ADDED prose of markdown and text writes. Repositories opt out
without touching the global config: `git config agentkit.prosepolice.enabled false`.

## `wait-police`

| Key       | Type | Default |
| --------- | ---- | ------- |
| `enabled` | bool | `true`  |

Refuses to end a turn while delegated work is still running with no bounded poll armed on its
artefact. Repositories opt out without touching the global config:
`git config agentkit.waitpolice.enabled false`.

## `wip`

Read by the `wip` surface, the `plan-gate` checker and the `plan-police` hook.

| Key            | Type  | Default                                                                     |
| -------------- | ----- | --------------------------------------------------------------------------- |
| `plan-paths`   | list  | `plans/`, `docs/plans/`, `doc/plans/`, `.omc/plans/`, `PLAN.md`, `PLANS.md` |
| `gap-headings` | regex | `known gaps\|loose ends\|snags`                                             |
| `done-markers` | regex | a `status: done\|shipped` line                                              |
| `issue-refs`   | regex | `#[0-9]+\|![0-9]+\|[A-Z][A-Z0-9]+-[0-9]+`                                   |

Setting `plan-paths` **replaces** the defaults outright rather than adding to them.

{{< callout type="info" >}}
A Jira-style `PROJ-123` is deliberately absent from the default `issue-refs`: nothing distinguishes
it from a hex digest or a UTF-8 label, and a wrong "tracked" loses the gap silently.
{{< /callout >}}

## `brain`

Two units under one banner: **memory** is what is true (additive — every note listed), **taste** is
what to do (replacement — a higher scope wins a name outright). They share a scope ladder and one
source resolver, never a store.

The banner is not the install boundary. **Taste ships with core** — the reader must be present
everywhere or a stated convention binds only the machines that opted in, and `taste-police` carries
no rules of its own, so it refuses nothing until a taste says `enforce: block`. The **memory vault**
is opt-in (`--with brain`): it injects context at every session start and writes into your tree.

| Key               | Type | Default |
| ----------------- | ---- | ------- |
| `memory.enabled`  | bool | `true`  |
| `memory.learning` | bool | `true`  |
| `memory.sources`  | list | `[]`    |
| `taste.enabled`   | bool | `true`  |
| `taste.learning`  | bool | `true`  |
| `taste.sources`   | list | `[]`    |

`enabled: false` makes that unit inert — nothing read, nothing written. `learning: false` keeps its
store read-only: a learning or correction is reported rather than filed.

Each unit reads two vaults, the repository's and the operator's, so knowledge that belongs to you
rather than to any one repository has somewhere to live:

| Unit   | Repository                 | User                  | External sources land in | Lock                    |
| ------ | -------------------------- | --------------------- | ------------------------ | ----------------------- |
| memory | `<repo>/memory/`           | `~/.agentkit/memory/` | `<vault>/external/`      | `.agentkit/memory.lock` |
| taste  | `<repo>/.agentkit/tastes/` | `~/.agentkit/tastes/` | `<tree>/external/`       | `.agentkit/tastes.lock` |

Each source takes `repo`, `ref`, `mode` (only `vendored` is implemented; declaring `reference` is an
error), `visibility` (`public` or `private`), and optionally `path` and `name`. `visibility` is
**required** of a source a repository vendors, and vendoring a private source into a public
repository is refused. A vendored source is re-snapshotted from its pinned ref on every sync, so it
is read-only in practice — which is how a human-authored knowledgebase is pulled in without a
separate mechanism: point `memory.sources` at the repository holding your ADRs, designs and
runbooks. See [tastes](/guide/concepts/tastes/) and [memory](/guide/concepts/memory/).

## `editor-police`

| Key              | Type   | Default                  |
| ---------------- | ------ | ------------------------ |
| `enabled`        | bool   | `true`                   |
| `repos`          | list   | `[]`                     |
| `editors`        | map    | `{}`                     |
| `fallback-email` | string | `nobody@example.invalid` |

Refuses a `git commit` in any repo matching a glob in `repos` until the session has named the
person at the keyboard, and again unless the commit carries that person as an `Edited-by`
trailer. Inert while `repos` is empty. `editors` maps a short name to the author string the
trailer carries, matched case-insensitively; a typed name the map does not know takes
`fallback-email`. The recipe is [Name the person at the keyboard](/cookbook/name-the-editor/).

```yaml
editor-police:
  enabled: true
  repos:
    - myorg/*/wiki
  editors:
    ana: "Ana Example <ana@example.com>"
  fallback-email: team@example.com
```

## Kill switches

Configuration is not the only lever. `AGENTKIT_SKIP_HOOKS` disables units for one session, and most
refusing units take a per-command override variable — all of them in the
[environment reference](/reference/environment/).
