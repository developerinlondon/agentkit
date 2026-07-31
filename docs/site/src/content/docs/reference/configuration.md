---
title: Configuration
description: Every key in config.yaml, its default, and which police implementation actually reads it.
sidebar:
  order: 2
---

One YAML file tunes the police units: thresholds, allowlists, review effort, and the `enabled`
switch that `resource-police`, `delegation-police` and `version-police` each carry.

|                 |                                                         |
| --------------- | ------------------------------------------------------- |
| Path            | `${XDG_CONFIG_HOME:-~/.config}/agentkit/config.yaml`    |
| Seeded from     | `config.example.yaml`, on a **global** install only     |
| Existing file   | preserved, never merged or rewritten                    |
| Repo-level file | `.agentkit/config.yaml` — read by `review-profile` only |

A global install copies `config.example.yaml` into place if nothing is there, and prints
`[config] Existing config preserved` otherwise (`install.sh`). A project install never touches it.

:::note[The repo-level file carries the `review` section]
`tools/review-profile` reads `<repo>/.agentkit/config.yaml` and merges its `review:` section over
the global one. Every other section is resolved from the global path — put `coding-police`
thresholds and the rest in `~/.config/agentkit/config.yaml`.
:::

## Where a key's reach is narrower than its name

Three keys are honoured by some surfaces and not others. Read these before relying on one, and
note that the tables below mark each case at the point it applies.

| Key                                                                | Reach                                      |
| ------------------------------------------------------------------ | ------------------------------------------ |
| `comment-police.forbidden-patterns` **replaces** the built-in list | a seeded config matches 6 patterns, not 13 |
| `comment-police.max-header-lines` + `forbidden-patterns`           | the OpenCode plugin only                   |
| repo-level `.agentkit/config.yaml`                                 | the `review:` section only                 |

## Which implementation reads which section

A police unit is a policy with up to three implementations, and they do not read config equally.

| Section             | Claude/Grok hook              | OpenCode plugin         | Codex policy                      |
| ------------------- | ----------------------------- | ----------------------- | --------------------------------- |
| `review`            | — (`review-profile` reads it) | —                       | —                                 |
| `git-police`        | `allowed-repos`               | `allowed-repos`         | not read                          |
| `coding-police`     | all keys                      | all keys                | not read                          |
| `comment-police`    | 3 of 5 keys (below)           | all keys                | not read                          |
| `pkg-police`        | `manager`                     | `manager`               | installed only for explicit `bun` |
| `resource-police`   | `enabled`, `bounded`          | `enabled`, `bounded`    | installed only when `enabled`     |
| `delegation-police` | `enabled`                     | `enabled`               | installed only when `enabled`     |
| `version-police`    | no such hook                  | `enabled`, `exceptions` | no such policy                    |

`format-police`, `kubectl-police`, `mr-police` and `pages-police` read no config at all; their
exceptions are per-command environment variables. The Codex `.rules` files contain no config
reader — they are static argv-prefix policies, so the installer reads the config for them and
installs, filters, or removes the corresponding rules file on each run.

## `review`

Selects review orchestration effort. `tools/review-profile` resolves it; the tool emits JSON and
decides nothing about merges.

| Key                 | Values                                       | Default      |
| ------------------- | -------------------------------------------- | ------------ |
| `profile`           | `fast` · `balanced` · `strict`               | `balanced`   |
| `primary-review`    | `nontrivial` · `always`                      | from profile |
| `specialist-review` | `never` · `critical` · `always`              | from profile |
| `product-review`    | `never` · `release` · `triggered` · `always` | from profile |
| `ci-evidence`       | `reuse` · `rerun`                            | from profile |
| `local-checks`      | `affected` · `full`                          | from profile |
| `evidence-note`     | `critical` · `always`                        | from profile |
| `min-severity`      | `info` · `low` · `medium` · `high`           | from profile |

`min-severity` is accepted by the parser but is not listed in `config.example.yaml`. It sets
`min_reported_severity` in the emitted JSON — the reviewer's reporting floor.

What each profile presets:

| Key                 | `fast`       | `balanced`   | `strict` |
| ------------------- | ------------ | ------------ | -------- |
| `primary-review`    | `nontrivial` | `nontrivial` | `always` |
| `specialist-review` | `never`      | `critical`   | `always` |
| `product-review`    | `release`    | `triggered`  | `always` |
| `ci-evidence`       | `reuse`      | `reuse`      | `rerun`  |
| `local-checks`      | `affected`   | `affected`   | `full`   |
| `evidence-note`     | `critical`   | `always`     | `always` |
| `min-severity`      | `medium`     | `low`        | `info`   |

Precedence, lowest to highest: built-in `balanced` → global config → repo config →
`AGENTKIT_REVIEW_PROFILE` → `--profile`. The last two override `profile` only; granular keys are
merged from the two config files, with the repo file winning.

The parser is strict and exits 2 rather than guessing:

- `review:` must be alone on its line — `review: balanced` is "unsupported review section syntax".
- An unknown key under `review:` is an error, not an ignored line.
- A duplicate key, or a key with an empty value, is an error.

:::note[Effort, not authority]
Nothing in this section can weaken a merge. With the `adversarial-review` kit installed, merge
authority lives in the target commit's `.agentkit/review-policy.json`, which `review-gate` reads
independently of any config file.
:::

## `git-police`

```yaml
git-police:
  branch-protection:
    allowed-repos: []
```

Repositories where direct commits and pushes to `main`/`master` are allowed. Entries match by
substring, so `brain` matches `myorg/brain`. Default is empty — every repo is protected.

This is the only `git-police` key. The stale-push and branch-stacking guards have no config; they
are overridden per command with `AGENTKIT_ALLOW_STALE_PUSH=1` and
`AGENTKIT_ALLOW_BRANCH_STACKING=1`.

## `coding-police`

| Key                    | Default | Effect                                                  |
| ---------------------- | ------- | ------------------------------------------------------- |
| `max-file-lines`       | `1000`  | lines in one file before it must be split               |
| `max-function-lines`   | `100`   | lines in one function before it must be decomposed      |
| `min-duplicate-lines`  | `6`     | identical consecutive lines that count as duplication   |
| `max-exports-per-file` | `15`    | exports in one file before it is doing too many things  |
| `max-dir-files`        | `15`    | source files in one directory; `0` disables the check   |
| `exclude-patterns`     | `[]`    | path substrings that skip the check (two effects below) |

`max-dir-files` is narrower than the other four. It runs on the `Write` family only — `Edit` cannot
create a file — and "new" means **git has never tracked the path**, tested with
`git ls-files --error-unmatch`. It fails open whenever it cannot tell: a tracked file, a directory
outside a git repository, or a missing `git` all return without a finding. What it counts is the
_sibling_ source files already in that directory, excluding the file being written, lock and
generated files (`*.lock`, `*.min.*`, `*.generated.*`, `*.snap`, `*.d.ts`, the three lockfile names),
and anything matching `exclude-patterns`. It fires when that count reaches the cap.

`exclude-patterns` entries are matched as plain **substrings** of the path, not globs, at two points:
a written file whose path contains any entry exits the hook entirely, and sibling files matching an
entry are not counted toward `max-dir-files`. It exists for legitimately homogeneous collections —
`routes/`, `migrations/`, `generated/`.

The bash hook's parser accepts an integer value only: a non-numeric value is skipped and the
built-in default stands, with no error.

## `comment-police`

| Key                  | Default              | Claude/Grok hook | OpenCode plugin |
| -------------------- | -------------------- | ---------------- | --------------- |
| `max-block-lines`    | `6`                  | read             | read            |
| `max-comment-ratio`  | `0.3`                | read             | read            |
| `exclude-patterns`   | `[]`                 | read             | read            |
| `max-header-lines`   | `10`                 | **not read**     | read            |
| `forbidden-patterns` | 13 built-in patterns | **not read**     | read            |

:::note[Two of these keys are read by the OpenCode plugin only]
`max-header-lines` and `forbidden-patterns` tune the OpenCode plugin. The Claude/Grok hook uses its
own fixed behaviour for both, described below.
:::

The two implementations diverge here, and the divergence is asymmetric:

- The hook runs no top-of-file header check at all, so `max-header-lines` has nothing to tune.
- The hook matches its own fixed list of seven forge-reference patterns (issue and MR numbers,
  forge URLs, commit shas, plan numbers) which cannot be configured.
- The plugin ships 13 default patterns and **replaces** them wholesale when
  `forbidden-patterns` is present.

:::note[`forbidden-patterns` replaces the built-in list]
Delete the key to keep the plugin's built-in 13 patterns. A present key **replaces** that list
rather than extending it, and the seeded `config.example.yaml` sets six entries — so a freshly
seeded config matches those six, without the bare `#123`, forge-URL and commit-sha matchers. Any
pattern you want kept has to be listed alongside your own.
:::

## `pkg-police`

```yaml
pkg-police:
  # auto | bun | npm | pnpm | yarn | off
  manager: auto
```

`auto` (the default) infers the manager from the repository's lockfile: `bun.lock` or `bun.lockb` →
bun, `package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn. Commands belonging to
any _other_ manager are then refused, with the equivalent command in the inferred one. **No lockfile,
or several that disagree, means there is no basis to judge and nothing is blocked.**

Naming a manager enforces it whatever the lockfile says. `off` disables the unit.

The walk starts at the working directory and stops at the git root, so a lockfile outside the
repository never decides policy. `AGENTKIT_ALLOW_PKG=1` overrides a single command regardless of this
setting, from the environment or as an inline prefix.

:::note[The unit enforces the project's manager, not a favoured one]
In a repository whose only lockfile is `package-lock.json`, `npm install` is what passes and
`bun install` is refused — the inference runs in every direction.
:::

Read by the Claude/Grok hook and the OpenCode plugin. Codex rules match literal argv prefixes and
cannot read a lockfile, so the static `policies/codex/pkg-police.rules` (which enforces bun) is
installed only when the config names `bun` explicitly; for `auto`, `off`, or any other manager the
installer removes it and Codex sessions rely on the recursive hooks of the other clients.

## `resource-police`

```yaml
resource-police:
  enabled: false
  bounded:
    - js-packages
    - js-scripts
    - typescript
    - playwright
    - cargo
    - go
    - moon
    - python
```

Off by default: nothing is bounded anywhere. When enabled, resource-intensive commands must run
through `bounded-run`, and `bounded` selects which command classes that covers — remove entries to
relax individual classes; omitting the list bounds every class, and an empty list bounds none.
`enabled` must be the literal `true`. Bounding matches command prefixes, so a privileged or remote
wrapper (`sudo`, `ssh`) around a heavy command is only caught when `delegation-police` is also
enabled. The Claude/Grok hook and the
OpenCode plugin honour a change immediately; the Codex policy is regenerated from the class list on
the next `install.sh` run.

| Class         | Covers                                            |
| ------------- | ------------------------------------------------- |
| `js-packages` | bun/npm/pnpm/yarn dependency changes              |
| `js-scripts`  | package-script builds, checks, lints, test suites |
| `typescript`  | `tsc` (direct, `bunx`, `npx`)                     |
| `playwright`  | `playwright test`                                 |
| `cargo`       | `cargo build/check/test/clippy`                   |
| `go`          | `go build/test`                                   |
| `moon`        | `moon ci/check/run`                               |
| `python`      | `pytest`, pip/uv installs                         |

## `delegation-police`

```yaml
delegation-police:
  enabled: false
```

Off by default: nothing is blocked. When enabled, delegated and privileged workloads — `ssh`,
`sudo`, ansible, container engines, service managers, kubectl mutations — are refused outside
engine-native limits, while read-only diagnostics (`docker ps`, `docker system df`,
`podman container inspect`, `systemctl status`, `kubectl get` …) stay allowed.
`AGENTKIT_ALLOW_DELEGATED=1` overrides a single command when the unit is enabled. The Claude/Grok
hook and the OpenCode plugin honour a change immediately; the Codex policy installs or uninstalls
on the next `install.sh` run.

## `version-police`

```yaml
version-police:
  enabled: true
  exceptions: []
```

Blocks writing a dependency pin that is a major version behind the live registry. `exceptions`
takes exact package names or `*` globs, and applies to every manifest including `package.json`,
which has no comments to carry an inline waiver.

`version-police` exists only as an OpenCode plugin — there is no Claude hook and no Codex policy —
so this section has no effect on the other three clients. It also honours
`AGENTKIT_SKIP_HOOKS=version-police`, but not the `all` keyword (see
[CLI and tools](/docs/reference/cli-and-tools/)).
