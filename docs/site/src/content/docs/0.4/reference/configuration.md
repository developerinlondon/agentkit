---
title: Configuration
description: Every key in config.yaml, its default, and which police
  implementation actually reads it.
sidebar:
  order: 2
slug: 0.4/reference/configuration
---

One YAML file tunes the police units. It is not where behaviour is switched on — every unit is
installed active, and config only moves thresholds, allowlists and review effort.

|                 |                                                         |
| --------------- | ------------------------------------------------------- |
| Path            | `${XDG_CONFIG_HOME:-~/.config}/agentkit/config.yaml`    |
| Seeded from     | `config.example.yaml`, on a **global** install only     |
| Existing file   | preserved, never merged or rewritten                    |
| Repo-level file | `.agentkit/config.yaml` — read by `review-profile` only |

A global install copies `config.example.yaml` into place if nothing is there, and prints
`[config] Existing config preserved` otherwise (`install.sh`). A project install never touches it.

:::caution[The repo-level file covers `review:` and nothing else]
`tools/review-profile` reads `<repo>/.agentkit/config.yaml` and merges its `review:` section over
the global one. Every police hook and OpenCode plugin reads the global path only — `coding-police`
thresholds in a repo's `.agentkit/config.yaml` are silently ignored.
:::

## Which implementation reads which section

A police unit is a policy with up to three implementations, and they do not read config equally.

| Section          | Claude/Grok hook              | OpenCode plugin         | Codex policy   |
| ---------------- | ----------------------------- | ----------------------- | -------------- |
| `review`         | — (`review-profile` reads it) | —                       | —              |
| `git-police`     | `allowed-repos`               | `allowed-repos`         | not read       |
| `coding-police`  | all keys                      | all keys                | not read       |
| `comment-police` | 3 of 5 keys (below)           | all keys                | not read       |
| `pkg-police`     | **not read**                  | `enabled`               | not read       |
| `version-police` | no such hook                  | `enabled`, `exceptions` | no such policy |

`format-police`, `kubectl-police`, `mr-police`, `pages-police` and `resource-police` read no config
at all; their exceptions are per-command environment variables. The Codex `.rules` files contain no
config reader — they are static argv-prefix policies.

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
Nothing in this section can weaken a merge. With the `strict-review` group installed, merge
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

| Key                    | Default | Effect                                                 |
| ---------------------- | ------- | ------------------------------------------------------ |
| `max-file-lines`       | `1000`  | lines in one file before it must be split              |
| `max-function-lines`   | `100`   | lines in one function before it must be decomposed     |
| `min-duplicate-lines`  | `6`     | identical consecutive lines that count as duplication  |
| `max-exports-per-file` | `15`    | exports in one file before it is doing too many things |
| `max-dir-files`        | `15`    | source files in one directory; `0` disables the check  |
| `exclude-patterns`     | `[]`    | path substrings skipped entirely                       |

`max-dir-files` fires only when a `Write` creates a **new** source file; editing an existing file in
a crowded directory never triggers it. `exclude-patterns` exists for legitimately homogeneous
collections — `routes/`, `migrations/`, `generated/`.

The bash hook's parser accepts an integer value only: a non-numeric value is skipped and the
built-in default stands, with no error.

## `comment-police`

| Key                  | Default              | Claude/Grok hook | OpenCode plugin |
| -------------------- | -------------------- | ---------------- | --------------- |
| `max-block-lines`    | `6`                  | read             | read            |
| `max-comment-ratio`  | `0.3`                | read             | read            |
| `exclude-patterns`   | `[]`                 | read             | read            |
| `max-header-lines`   | `10`                 | **not read**     | read            |
| `forbidden-patterns` | 14 built-in patterns | **not read**     | read            |

The two implementations diverge here, and the divergence is asymmetric:

- The hook runs no top-of-file header check at all, so `max-header-lines` has nothing to tune.
- The hook matches its own fixed list of seven forge-reference patterns (issue and MR numbers,
  forge URLs, commit shas, plan numbers) which cannot be configured.
- The plugin ships 14 default patterns and **replaces** them wholesale when
  `forbidden-patterns` is present.

:::caution[The seeded config narrows the OpenCode plugin]
`config.example.yaml` sets `forbidden-patterns` to six entries. Because a present key replaces the
default list rather than extending it, a freshly seeded config leaves the OpenCode plugin matching
six patterns instead of its built-in 14 — dropping the bare `#123`, forge-URL and commit-sha
matchers. Delete the key to keep the built-in set.
:::

## `pkg-police`

```yaml
pkg-police:
  enabled: true
```

`false` allows `npm`, `npx`, `yarn` and `pnpm`. Read by the OpenCode plugin only, which matches the
literal shape `pkg-police:` followed by `enabled: false`. **The Claude/Grok hook does not read
this key** — under Claude, the only way past `pkg-police` is prefixing the one command with
`AGENTKIT_ALLOW_PKG=1`.

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
[CLI and tools](/0.4/reference/cli-and-tools/)).
