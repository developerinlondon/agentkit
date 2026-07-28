# agentkit

Reusable AI agent skills, rules, plugins, hooks, and tools for OpenCode, Claude Code, Codex CLI, Grok CLI, and other AI coding agents.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## What's Included

### Skills (SKILL.md -- works everywhere via skills.sh)

| Skill                       | Description                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **gitops-master**           | GitOps operations for ArgoCD + Kargo: diagnose, verify, promote, setup                                       |
| **autonomous-workflow**     | Proposal-first development, commit hygiene, decision authority                                               |
| **adversarial-review**      | Trace-first falsification of plans and diffs with replayable evidence                                        |
| **code-quality**            | Warnings-as-errors, no underscore prefixes, test coverage                                                    |
| **documentation**           | Surface-aware diagrams (Mermaid / ASCII), structured plan format, formatting rules                           |
| **issue-raiser**            | GitLab issue creation with root cause analysis and git-history-based assignees                               |
| **product-intelligence**    | Evidence-backed product briefs with a claim-by-claim ledger; hardened acquisition (opt-in: `--with product`) |
| **project-planning**        | Structured project planning: break down ideas into architecture, file structure, roadmap                     |
| **product-review**          | Build, run, and use declared product surfaces as a separate review lane (opt-in: `--with product`)           |
| **resource-safe-execution** | On Linux, runs heavy developer commands inside deterministic systemd resource limits                         |

### Rules (auto-loaded by file glob match)

| Rule                     | Glob                                            | Description                                                                |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- |
| **consent-protocol**     | `**/*`                                          | Stop after asking a question -- never act and ask in the same turn         |
| **credential-bootstrap** | `gitops/**/*.yaml`                              | OpenBao + ESO credential bootstrap pattern for GitOps apps                 |
| **coding-standards**     | `**/*.{ts,py,go,rs...}`                         | Enforces DRY, modularity, and focused functions proactively                |
| **comment-discipline**   | `**/*.{ts,py,go,rs,sh,yaml,toml,Dockerfile...}` | Default to no comments; only WHY when non-obvious                          |
| **issue-tracking**       | `**/*`                                          | File a tracker issue before non-trivial work; close the loop when it ships |

### Plugins (OpenCode only -- runtime hooks)

| Plugin                 | Description                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **version-police.ts**  | Blocks writing dependency pins that are a major version behind the live registry (stale training-data pins)              |
| **format-police.ts**   | Auto-formats files on write using dprint                                                                                 |
| **kubectl-police.ts**  | Blocks kubectl create/apply for Kargo CRDs (unconditionally)                                                             |
| **git-police.ts**      | Blocks commits to main/master, force push, --no-verify, AI attribution, push to protected branches                       |
| **coding-police.ts**   | Enforces DRY code, modular files (<1000 lines), short functions, single responsibility, and capped directory file counts |
| **comment-police.ts**  | Warns on long comment blocks, tutorial-style file headers, PR/plan/closes-#N references, and high comment-to-code ratios |
| **pkg-police.ts**      | Enforces bun as package manager — blocks npm, npx, yarn, pnpm commands                                                   |
| **resource-police.ts** | Requires bounded heavy commands on Linux; blocks delegated and undecidable commands everywhere                           |

### Runtime hooks (Claude Code; review gate also installed for Codex)

| Hook                   | Type              | Description                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **git-police.sh**      | PreToolUse        | Blocks force push, --no-verify, Co-authored-by trailers, commits to protected branches, stale pushes (feature branch behind the default branch)                                                                                                                                                                                                                            |
| **kubectl-police.sh**  | PreToolUse        | Blocks kubectl create/apply on Kargo CRDs                                                                                                                                                                                                                                                                                                                                  |
| **format-police.sh**   | PostToolUse       | Auto-formats files after edit/write using dprint                                                                                                                                                                                                                                                                                                                           |
| **coding-police.sh**   | PostToolUse       | Enforces DRY code, modular files (<1000 lines), short functions, single responsibility, and capped directory file counts                                                                                                                                                                                                                                                   |
| **pkg-police.sh**      | PreToolUse        | Enforces bun as package manager — blocks npm, npx, yarn, pnpm commands                                                                                                                                                                                                                                                                                                     |
| **resource-police.sh** | PreToolUse        | With `jq`, `awk`, and `cat`, requires `bounded-run` for heavy commands on Linux and blocks delegated or undecidable commands on every platform; warns and fails open when a parser dependency is missing                                                                                                                                                                   |
| **chime.sh**           | Notification/Stop | Audible nudge when Claude needs you: springy boing on permission prompts/questions, soft ping when a turn finishes. Mute: `touch ~/.claude/.chime-off` or `CLAUDE_CHIME=0`                                                                                                                                                                                                 |
| **mr-police.sh**       | PreToolUse        | Blocks opening a new MR while you already have an open MR you authored on the repo — stops unmerged MRs from stacking up                                                                                                                                                                                                                                                   |
| **review-police.sh**   | PreToolUse        | Allows one standalone `gh pr merge`/`glab mr merge` only when evidence covers the forge's exact source and target; direct REST/GraphQL/MCP and compound/wrapped merges are refused. Strict policy comes from the target commit, risk comes from commit-bound paths, and critical records cannot use local consent. NOT security — forge protections are the trust boundary |

Codex receives the fail-closed `review-police` route through its trusted
`PreToolUse` hook interface. The installer preserves unrelated entries in
`$CODEX_HOME/hooks.json` (falling back to `~/.codex/hooks.json`) or
`<project>/.codex/hooks.json`; open `/hooks` in a new Codex session to review
and trust the installed definition. Hook merging requires `jq`; without it the
installer warns and leaves the optional Codex hook unwired. The other Codex
protections below remain literal command-prefix policies.

### Policies (Codex CLI -- exec policy)

| Policy                      | Description                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **git-police.rules**        | Blocks force push, --no-verify, direct push to protected branches                                            |
| **kubectl-police.rules**    | Blocks kubectl create/apply on Kargo CRDs                                                                    |
| **coding-police.rules**     | Coding standards guidance + prompts on heredoc/tee writes that may produce oversized files                   |
| **pkg-police.rules**        | Enforces bun as package manager — blocks npm, npx, yarn, pnpm commands                                       |
| **delegation-police.rules** | Blocks direct mutating container, service-manager, privilege, and remote prefixes; allows direct diagnostics |
| **resource-police.rules**   | On Linux, blocks direct heavy commands that do not start with the bounded runner                             |

Codex exec policy evaluates literal argv prefixes. It does not recursively parse shell payloads,
skip arbitrary options before a subcommand, or model `service NAME ACTION` with an arbitrary service
name. `delegation-police.rules` covers the direct forms the policy language can represent; Claude
and OpenCode `resource-police` remain the recursive command-analysis paths.

### Instructions (global agent prompts wired into Claude / Codex / OpenCode)

| Instruction                     | Description                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| **anti-glaze.md**               | Tone and reasoning layer: precise, direct, no sycophancy, explicit confidence levels                |
| **coding-discipline.md**        | 11-rule behavioral contract for code work (think first, simplicity, surgical changes, fail loud, …) |
| **collaboration-visibility.md** | Progress updates, checkpoint summaries, and compact ASCII diagrams for multi-step work              |
| **resource-safety.md**          | Mandatory bounded execution and live-connectivity preservation rules                                |

### Claude Code plugins (marketplace)

Hooks, skills, and tools ship as Claude Code plugins (ADR #45 — the generic units — MCP tools,
skills, hook scripts — are the source of truth; plugins are convenience wrappers). Add the
marketplace once, then install. The **agentkit** plugin is the recommended Claude bundle: a single
`claude plugin install agentkit` gives you the enforcement hooks, the skills, the portable
`review-gate`, `review-profile`, the Linux-only bounded runner, and **both** MCP toolchains
(assay + infra-tools).
Resource execution additionally requires a
configured systemd user manager and the host-provisioned `agent-work.slice`. The
granular **assay** and **infra-tools** plugins remain for à-la-carte installs.

```bash
claude plugin marketplace add developerinlondon/agentkit

# Recommended: everything in one step — hooks + skills + assay + infra-tools MCP
claude plugin install agentkit

# Or à-la-carte — just one toolchain
claude plugin install assay
claude plugin install infra-tools

# Opt-in skill groups ship as their own plugins
claude plugin install agentkit-product
```

| Plugin               | Provides                                                                                                                                                                                                                                                                                                                                     | Source                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **agentkit**         | Claude bundle: enforcement police hooks, skills, portable review tools, Linux-only `tools/bounded-run`, and both MCP toolchains. Hooks and review tools need `jq`, `git`, `awk`, and `cat`; MCPs need `bun` and `assay`. Linux bounded execution additionally needs cgroup v2, a systemd user manager, and a provisioned `agent-work.slice`. | local `plugins-cc/agentkit/`                                                                  |
| **agentkit-product** | The `product` skill group: product-intelligence and product-review. Generated from `skills/GROUPS` — one plugin per declared group, `agentkit` being the core one.                                                                                                                                                                           | local `plugins-cc/agentkit-product/`                                                          |
| **assay**            | Gated Lua infra toolkit (`assay_run` + `assay_context`) — Kubernetes, ArgoCD, Vault, Prometheus, GitLab, AWS, … through one read-only/approval-gated tool. Requires the `assay` binary on PATH.                                                                                                                                              | vendored from [developerinlondon/assay](https://github.com/developerinlondon/assay) `plugin/` |
| **infra-tools**      | Read-only helm / tofu / git tools (`helm_template`/`helm_list`/`helm_get_values`, `tofu_plan`/`tofu_show`/`tofu_state_list`, `git_log`/`git_diff`/`git_status`/`git_clone_ro`) as a typed MCP server — render charts, preview plans, read git history. Never applies or mutates. Requires `bun` on PATH.                                     | local `plugins-cc/infra-tools/`                                                               |

**Not in the plugin: the always-on rules and instructions.** Claude Code plugins cannot inject
always-on global context, so the glob-loaded `rules/` and the `instructions/*.md` global prompts
(anti-glaze, coding-discipline, collaboration-visibility, resource-safety) are **out of scope for the plugin** and
are still wired into `~/.claude/CLAUDE.md`, Codex, and OpenCode by `install.sh`. Their
**enforcement**, however, _is_ bundled: the police hooks (`git-police`, `mr-police`,
`format-police`, `coding-police`, `kubectl-police`, `pkg-police`, `resource-police`) run as
PreToolUse / PostToolUse
hooks inside the `agentkit` plugin. These hooks are defense-in-depth command detection; the runner,
aggregate slice, and host service limits are the resource and connectivity boundaries.

## Installation

### Option 1: skills.sh CLI (skills only, all agents)

```bash
npx skills add developerinlondon/agentkit
```

This installs SKILL.md files for your AI agent (Claude Code, OpenCode, Cursor, etc.).

### Option 2: Install globally (all projects)

```bash
git clone git@github.com:developerinlondon/agentkit.git
./agentkit/install.sh --global
```

**One shared content tree, client adapters by symlink.** Portable units land once under
`~/.agentkit/{skills,rules,instructions,hooks,tools}`. Each client then gets **per-name**
symlinks into that root (never a second full copy):

| Client      | Adapter                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------- |
| OpenCode    | `~/.agents/skills\|rules\|instructions` → `~/.agentkit/…`                                           |
| Claude Code | `~/.claude/skills\|hooks\|tools` → `~/.agentkit/…` (settings still point at `~/.claude/hooks`)      |
| Grok CLI    | `~/.grok/skills\|rules` → `~/.agentkit/…`; instructions also as `~/.grok/rules/*.md` (always-on)    |
| Codex CLI   | policies, prompts, review hooks, validator, and profile resolver under `$CODEX_HOME` or `~/.codex/` |

Per-name links mean non-agentkit siblings stay put — OMC skills under `~/.claude/skills/`,
Grok builtins under `~/.grok/skills/`, etc. OpenCode plugins still install as real files under
`~/.config/opencode/plugins/` (runtime TS, not portable units). Tools also land on
`~/.local/bin/`. Instructions are wired into Codex (`developer_instructions`), Claude Code
(`~/.claude/CLAUDE.md` markered blocks), OpenCode (`instructions[]`), and Grok
(`~/.grok/rules/`) idempotently.

Override the shared root with `AGENTKIT_HOME=/path` if needed.

**Skill groups.** `skills/GROUPS` declares the groups and their membership; a skill with no
entry is in `core`, which always installs. Adding a group is a manifest entry — the installer,
the plugin generator, and the tests all read it rather than hard-coding names.

```bash
./agentkit/install.sh --global                  # core only (or whatever you chose last time)
./agentkit/install.sh --global --with product   # + product-intelligence, product-review
./agentkit/install.sh --global --all            # every declared group
```

Run bare on a terminal with nothing remembered yet, the installer asks about each optional
group rather than quietly settling for `core`: answer `y` to add one, and anything else —
including a bare enter — declines it. A pipe, a CI runner, any group flag, or a selection
already remembered skips the question, so scripted installs stay unattended.

A global install records the chosen groups in `~/.agentkit/groups`, so a later bare
`install.sh --global` upgrades the same set with no flags to remember — `--with` adds to that
set rather than replacing it, and `--without <group>` drops one (`core` cannot be dropped). An
unknown group left in that file is reported and ignored rather than taken as a selection.
Skills already installed from an unselected group are kept and refreshed: deselection changes
what is chosen, never what is on disk, so an upgrade never removes a skill you are using.
Project installs take groups per invocation and persist nothing.

Each group also ships as its own Claude Code plugin, generated from the same manifest by
`scripts/sync-cc-plugin.sh`: `agentkit` for core, `agentkit-<group>` for the rest (so
`agentkit-product`). In `--claude-plugin` mode the installer installs one plugin per selected
group, and updates a group plugin you already have even when this run did not select it.

The installer detects `linux`, `darwin`, or `unknown`; `AGENTKIT_PLATFORM` may override detection
with one of those exact values for controlled packaging and tests. Artifacts carrying an
`agentkit:platform` directive are skipped when unsupported, and stale managed copies are removed.
On non-Linux hosts this omits `bounded-run`, its `agentkit-run` alias, and the Codex heavy-command
policy. Linux-only per-session systemd scoping is also skipped. The portable Codex review hook
remains installed. OpenCode still blocks delegated and undecidable commands. The Claude hook does
so when `jq`, `awk`, and `cat` are available; otherwise it warns and intentionally fails open.

### Option 3: Install into a specific project

```bash
./agentkit/install.sh /path/to/your/project
```

Copies skills, rules, and plugins into the project's `.opencode/` directory.

### Option 4: Manual

Copy what you need:

```bash
cp -r skills/gitops-master/ your-project/.opencode/skills/
cp rules/credential-bootstrap.md your-project/.opencode/rules/
cp plugins/version-police.ts your-project/.opencode/plugins/
```

### Grok CLI

Grok loads agentkit **hooks** via Claude settings compatibility (`~/.claude/settings.json`
when `[compat.claude] hooks = true`, the default). Soft guidance (skills/rules/instructions)
is separate. Full install, soft-vs-hard table, and a deny probe:

**[docs/grok.md](./docs/grok.md)**

Police scripts accept both Claude snake_case and Grok camelCase payloads and dual-emit deny
JSON so either harness can block. Matcher aliases alone are not enough.

### Agent review / merge gate

`review-police` resolves the forge's exact source head and current target, loads policy from that
target commit, and validates a context-bound evidence index. The source branch cannot weaken the
policy judging itself. A reviewed merge must be one standalone `gh pr merge` or `glab mr merge`
command carrying that exact head through `--match-head-commit` or `--sha`. GitLab commands must
also pass `--auto-merge=false` so current `glab` does not defer the action. GitHub target-branch
rules are checked and merge-queue targets are refused because current `gh` implicitly defers them.
Direct REST/GraphQL/MCP and compound or wrapped merges are denied because their landing context
cannot be bound safely. Record schemas, bootstrap behavior, evidence obligations, trust limits,
and consent boundaries:

The same shell gate is wired into Claude Code, Grok's Claude-compatible hook path, and current
Codex `PreToolUse` hooks. Codex requires an explicit trust review through `/hooks` after the
definition is installed or changed.

**[docs/review-process.md](./docs/review-process.md)**

### Tools

On Linux, global installs place the bounded runner on `~/.local/bin/` and preserve a mirror in
`~/.claude/tools/`. Portable tools install on every supported host.

| Tool                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **bounded-run**        | Linux-only direct-argv workload runner for the bounded `agent-work.slice` service    |
| **review-gate**        | Portable strict review-policy and evidence-record validator used by `review-police`  |
| **review-profile**     | Resolves configurable review lanes and verification effort for the current task      |
| **fix-ascii-boxes.py** | Fixes ASCII box-drawing alignment in markdown files, handles nested boxes inside-out |

`bounded-run` fails closed unless the aggregate slice matches its expected limits (default
20G/24G memory high/max, 800% CPU, 1536 tasks; hosts sized differently pin their values in
root-owned `/etc/agentkit/resource-guard.conf`), cgroup v2 is available, and host headroom
checks pass. Its profiles are fixed and tested together with the host configuration
(`agentkit-run` remains as a compat symlink from the tool's previous name):

| Profile   | Memory high/max | CPU | Tasks | Command timeout |
| --------- | --------------- | --- | ----- | --------------- |
| `canary`  | 1G / 2G         | 2   | 64    | 60s             |
| `default` | 6G / 8G         | 2   | 256   | 10m             |
| `compile` | 8G / 12G        | 4   | 512   | 15m             |
| `browser` | 12G / 16G       | 4   | 1024  | 20m             |

Container engines, direct `systemd-run`, and remote execution are not supported containment
targets because they can delegate work outside the transient cgroup.

On Linux, project-only installs expose the runner as `./.claude/tools/bounded-run`. The Claude
plugin bundles it at `$CLAUDE_PLUGIN_ROOT/tools/bounded-run`, and its hook reports that resolved
path when denying an unbounded command. Global installs expose `bounded-run` through
`~/.local/bin`. On non-Linux, OpenCode keeps delegation analysis active without the runner. The
Claude hook does so when `jq`, `awk`, and `cat` are available and otherwise warns before failing
open.

## Configuration

Agentkit uses a YAML config file at `~/.config/agentkit/config.yaml` (respects `XDG_CONFIG_HOME`).
The installer creates a default config from `config.example.yaml` on first run.

```yaml
review:
  profile: balanced

git-police:
  branch-protection:
    allowed-repos:
      - brain
      - my-notes
```

### review

Run `review-profile --repo . --risk trivial|standard|critical` before final verification and add
`--release` or `--user-facing` when applicable. It emits the resolved settings and Boolean lane
decisions as JSON. `AGENTKIT_REVIEW_PROFILE` or `--profile` provides a session/task override.

| Profile    | Primary review      | Specialist review | Product review                    | CI evidence | Local checks |
| ---------- | ------------------- | ----------------- | --------------------------------- | ----------- | ------------ |
| `fast`     | non-trivial changes | never             | releases                          | reuse       | affected     |
| `balanced` | non-trivial changes | critical changes  | critical, release, or user-facing | reuse       | affected     |
| `strict`   | every change        | every change      | every change                      | rerun       | full         |

The default is `balanced`: one exact-head adversarial review for ordinary code work, with extra
lanes only when risk or product exposure justifies them. `fast` does not mean unreviewed ordinary
code; it removes the second specialist lane and narrows product review. `strict` preserves the
maximal workflow.

Tune any preset with these keys under `review:`:

| Setting             | Values                                    | Meaning                                                            |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `primary-review`    | `nontrivial`, `always`                    | When the exact-head diff review runs                               |
| `specialist-review` | `never`, `critical`, `always`             | When a second independent specialist runs                          |
| `product-review`    | `never`, `release`, `triggered`, `always` | `triggered` means critical, release, or user-facing                |
| `ci-evidence`       | `reuse`, `rerun`                          | Reuse passed CI bound to the exact source SHA or repeat it locally |
| `local-checks`      | `affected`, `full`                        | Final local verification scope                                     |
| `evidence-note`     | `critical`, `always`                      | When to post a combined durable evidence note                      |

Configuration precedence is command-line profile, `AGENTKIT_REVIEW_PROFILE`, repository profile,
global profile, then `balanced`. Granular global overrides apply after the preset and repository
overrides apply last. Put repository overrides in `.agentkit/config.yaml`; put machine defaults in
`~/.config/agentkit/config.yaml`.

These settings choose workflow effort only. The exact target commit's
`.agentkit/review-policy.json`, protected CI, and forge approvals remain authoritative and can
require checks, product coverage, analyses, or evidence that a local profile would otherwise omit.
Profile activations and merge-gate duration are recorded without repository paths or commands in
`~/.agentkit/review-audit.log`.

### git-police.branch-protection.allowed-repos

Repos listed here are exempt from branch protection rules (direct commits/pushes to main/master
are allowed). Use the repo name (e.g. `brain`) or `owner/name` (e.g. `myorg/brain`). Partial
matches are supported.

### coding-police

All thresholds are configurable:

| Setting                | Default | Description                                                              |
| ---------------------- | ------- | ------------------------------------------------------------------------ |
| `max-file-lines`       | 1000    | Files exceeding this trigger a split warning                             |
| `max-function-lines`   | 100     | Functions exceeding this trigger a decompose warning                     |
| `min-duplicate-lines`  | 6       | Minimum identical consecutive lines to flag as duplicate                 |
| `max-exports-per-file` | 15      | Exports exceeding this trigger a responsibility warning                  |
| `max-dir-files`        | 15      | Directory file count that blocks creating another flat file (0 disables) |
| `exclude-patterns`     | `[]`    | File path substrings to skip (e.g. `generated/`)                         |

`max-dir-files` only fires when a Write **creates a new** source file in a directory already at
or over the cap — editing an existing file in a crowded directory is always allowed. A directory
with mixed concerns (handlers, helpers, types all flat) should split into domain subfolders once
it hits the cap. A homogeneous one-file-per-item collection (`routes/`, `migrations/`) is a
different shape and legitimately outgrows the cap — add it to `exclude-patterns` instead of
raising the cap globally.

## gitops-master Setup

The gitops-master skill needs to know your cluster environment. Create a `.gitops-config.yaml` in
your project root:

```yaml
ssh_command: "MISE_ENV=test mise run server:ssh"
kargo_namespace: "kargo-my-project-test"
argocd_namespace: "infra"
monitoring_namespace: "monitoring"
app_namespace: "my-app-test"
domain: "example.com"
kargo_project: "my-project"
warehouse_name: "platform-apps"
```

If no config file exists, the skill will attempt auto-discovery from the cluster, or ask you for the
values.

## Plugins

Plugins are OpenCode-specific (they use the `@opencode-ai/plugin` TypeScript API). They hook into
OpenCode's tool execution lifecycle to enforce safety and quality gates.

**version-police**: Stops agents from pinning stale dependency versions recalled from training data.
On every write/edit to a dependency manifest it detects the pins that are newly added or changed,
looks each one up against the live upstream registry, and **blocks** the write when a pin is one or
more **major** versions behind the latest release. Minor/patch lag is warned about (logged,
non-blocking).

Supported manifests and registries:

| Manifest                                    | Registry        |
| ------------------------------------------- | --------------- |
| `package.json`                              | npm registry    |
| `Cargo.toml`                                | crates.io       |
| `pyproject.toml`, `requirements*.txt`       | PyPI            |
| `Dockerfile` (`FROM`), `docker-compose.yml` | Docker Hub      |
| `go.mod`                                    | Go module proxy |

Built for hook speed: only diff-changed pins are checked, each lookup has a ~2.5s timeout and
**fails open** on any network error (registry downtime never blocks a write), and results are cached
on disk (`$XDG_CACHE_HOME/agentkit/version-police.json`) for 24h.

**Overrides** (when a pin is deliberate):

- Inline annotation on the pin line (or the line directly above), for any comment-bearing manifest:
  ```toml
  serde = "0.9" # version-police: allow serde -- locked for MSRV
  ```
  `package.json` is JSON and has no comments, so use the config exceptions list instead.
- Config exceptions list in your agentkit config (applies to every manifest, including
  `package.json`) — package names, `*` globs supported:
  ```yaml
  version-police:
    exceptions:
      - serde
      - "@types/*"
  ```

Disable entirely with `version-police.enabled: false` in your config, or by adding `version-police`
to the `AGENTKIT_SKIP_HOOKS` comma-separated env list.

| Platform | File                        | Hook type           |
| -------- | --------------------------- | ------------------- |
| OpenCode | `plugins/version-police.ts` | tool.execute.before |

**format-police.ts**: Auto-formats files after every write/edit using dprint. Auto-discovers the
dprint binary from PATH or mise.

**kubectl-police.ts**: Intercepts bash commands before execution (`tool.execute.before`) and
unconditionally blocks `kubectl create/apply` for Kargo CRDs (Promotion, Stage, Freight, Warehouse).
These poison the Kargo stage state machine when created via kubectl. Read-only commands
(`kubectl get/describe/logs`) and recovery commands (`kubectl delete`) are always allowed.

**git-police.ts**: Intercepts git commands before execution and blocks:

- Commits directly to main/master -- must use feature branches
- Force push (`--force`, `--force-with-lease`) -- rewrites history
- `--no-verify` flag -- bypasses pre-commit hooks and quality gates
- AI attribution trailers (`Co-authored-by`) in commit messages
- Push directly to protected branches -- must use PRs

Repos listed in `git-police.branch-protection.allowed-repos` in your config are exempt from branch
protection rules. See [Configuration](#configuration).

**coding-police**: Enforces coding standards on every file write/edit. Available on all three
platforms (OpenCode plugin, Claude Code hook, Codex policy). Checks:

- File length -- files over 1000 lines must be split into smaller modules by functionality
- Function length -- functions over 100 lines must be decomposed into focused helpers
- Duplicate code -- repeated blocks of 6+ lines must be extracted into shared functions (DRY)
- Export count -- files with too many exports need single-responsibility refactoring (TS/JS only)

| Platform    | File                                 | Hook type          |
| ----------- | ------------------------------------ | ------------------ |
| OpenCode    | `plugins/coding-police.ts`           | tool.execute.after |
| Claude Code | `hooks/claude/coding-police.sh`      | PostToolUse        |
| Codex CLI   | `policies/codex/coding-police.rules` | exec policy        |

All thresholds are configurable via `coding-police` in your config. See [Configuration](#configuration).

**pkg-police**: Enforces bun as the default JavaScript/TypeScript package manager and runtime.
Intercepts bash commands before execution and blocks npm, npx, yarn, and pnpm. Available on all
three platforms (OpenCode plugin, Claude Code hook, Codex policy).

Blocked commands and their bun equivalents:

| Blocked             | Use instead             |
| ------------------- | ----------------------- |
| `npm install`       | `bun install`           |
| `npm install <pkg>` | `bun add <pkg>`         |
| `npm run <script>`  | `bun run <script>`      |
| `npx <cmd>`         | `bunx <cmd>`            |
| `npm test`          | `bun test`              |
| `yarn` / `pnpm`     | `bun` (same subcommand) |

| Platform    | File                              | Hook type           |
| ----------- | --------------------------------- | ------------------- |
| OpenCode    | `plugins/pkg-police.ts`           | tool.execute.before |
| Claude Code | `hooks/claude/pkg-police.sh`      | PreToolUse          |
| Codex CLI   | `policies/codex/pkg-police.rules` | exec policy         |

Disable per-project by setting `pkg-police.enabled: false` in your agentkit config.
Override per-command when the user explicitly requests a different package manager.

## Rules

Rules are auto-loaded by OpenCode when you edit files matching their glob pattern. Unlike skills
(which must be explicitly loaded), rules are always-on context.

**credential-bootstrap.md**: Activated when editing `gitops/**/*.yaml`. Provides the full OpenBao +
ESO credential bootstrap pattern -- 3 template files (presync-rbac, presync-bootstrap,
externalsecret) that auto-generate and manage secrets for any GitOps app.

**coding-standards.md**: Proactive context for code files. Sets the mental model for the agent _before_ it starts writing. Defines the 1000-line file limit, 100-line function limit, and DRY requirements.

## Contributing

1. Skills follow the [skills.sh](https://skills.sh) / [agentskills.io](https://agentskills.io) standard
2. Each skill lives in `skills/<name>/SKILL.md` with optional `references/` and `scripts/` subdirs
3. Rules live in `rules/<name>.md` with frontmatter globs for auto-loading
4. Plugins live in `plugins/<name>.ts` and implement the OpenCode plugin API
5. Tools live in `tools/<name>` and are standalone executable scripts (Python/Bash)
