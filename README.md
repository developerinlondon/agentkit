# agentkit

Reusable AI agent skills, rules, plugins, hooks, and tools for OpenCode, Claude Code, and other AI coding agents.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## What's Included

### Skills (SKILL.md -- works everywhere via skills.sh)

| Skill                       | Description                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| **gitops-master**           | GitOps operations for ArgoCD + Kargo: diagnose, verify, promote, setup                   |
| **autonomous-workflow**     | Proposal-first development, commit hygiene, decision authority                           |
| **code-quality**            | Warnings-as-errors, no underscore prefixes, test coverage                                |
| **documentation**           | Surface-aware diagrams (Mermaid / ASCII), structured plan format, formatting rules       |
| **issue-raiser**            | GitLab issue creation with root cause analysis and git-history-based assignees           |
| **project-planning**        | Structured project planning: break down ideas into architecture, file structure, roadmap |
| **resource-safe-execution** | Runs heavy developer commands inside deterministic systemd resource limits               |

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
| **coding-police.ts**   | Enforces DRY code, modular files (<1000 lines), short functions, and single responsibility                               |
| **comment-police.ts**  | Warns on long comment blocks, tutorial-style file headers, PR/plan/closes-#N references, and high comment-to-code ratios |
| **pkg-police.ts**      | Enforces bun as package manager — blocks npm, npx, yarn, pnpm commands                                                   |
| **resource-police.ts** | Requires bounded execution for heavy commands and blocks cgroup delegation escapes                                       |

### Hooks (Claude Code -- PreToolUse / PostToolUse)

| Hook                   | Type              | Description                                                                                                                                                                |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **git-police.sh**      | PreToolUse        | Blocks force push, --no-verify, Co-authored-by trailers, commits to protected branches, stale pushes (feature branch behind the default branch)                            |
| **kubectl-police.sh**  | PreToolUse        | Blocks kubectl create/apply on Kargo CRDs                                                                                                                                  |
| **format-police.sh**   | PostToolUse       | Auto-formats files after edit/write using dprint                                                                                                                           |
| **coding-police.sh**   | PostToolUse       | Enforces DRY code, modular files (<1000 lines), short functions, single responsibility                                                                                     |
| **pkg-police.sh**      | PreToolUse        | Enforces bun as package manager — blocks npm, npx, yarn, pnpm commands                                                                                                     |
| **resource-police.sh** | PreToolUse        | Requires `bounded-run` for heavy commands and blocks cgroup delegation escapes                                                                                            |
| **chime.sh**           | Notification/Stop | Audible nudge when Claude needs you: springy boing on permission prompts/questions, soft ping when a turn finishes. Mute: `touch ~/.claude/.chime-off` or `CLAUDE_CHIME=0` |
| **mr-police.sh**       | PreToolUse        | Blocks opening a new MR while you already have an open MR you authored on the repo — stops unmerged MRs from stacking up                                                   |

### Policies (Codex CLI -- exec policy)

| Policy                    | Description                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **git-police.rules**      | Blocks force push, --no-verify, direct push to protected branches                          |
| **kubectl-police.rules**  | Blocks kubectl create/apply on Kargo CRDs                                                  |
| **coding-police.rules**   | Coding standards guidance + prompts on heredoc/tee writes that may produce oversized files |
| **pkg-police.rules**      | Enforces bun as package manager — blocks npm, npx, yarn, pnpm commands                     |
| **resource-police.rules** | Blocks direct heavy commands and service or container delegation escape paths              |

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
`claude plugin install agentkit` gives you the enforcement hooks, the skills, the bounded runner,
and **both** MCP toolchains (assay + infra-tools). Resource execution additionally requires a
configured systemd user manager and the host-provisioned `agent-work.slice`. The
granular **assay** and **infra-tools** plugins remain for à-la-carte installs.

```bash
claude plugin marketplace add developerinlondon/agentkit

# Recommended: everything in one step — hooks + skills + assay + infra-tools MCP
claude plugin install agentkit

# Or à-la-carte — just one toolchain
claude plugin install assay
claude plugin install infra-tools
```

| Plugin          | Provides                                                                                                                                                                                                                                                                                                 | Source                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **agentkit**    | Claude bundle: enforcement police hooks, skills, `tools/bounded-run`, and both MCP toolchains. Needs `jq`, `bun`, `assay`, cgroup v2, a systemd user manager, and a provisioned `agent-work.slice`.                                                                                                     | local `plugins-cc/agentkit/`                                                                  |
| **assay**       | Gated Lua infra toolkit (`assay_run` + `assay_context`) — Kubernetes, ArgoCD, Vault, Prometheus, GitLab, AWS, … through one read-only/approval-gated tool. Requires the `assay` binary on PATH.                                                                                                          | vendored from [developerinlondon/assay](https://github.com/developerinlondon/assay) `plugin/` |
| **infra-tools** | Read-only helm / tofu / git tools (`helm_template`/`helm_list`/`helm_get_values`, `tofu_plan`/`tofu_show`/`tofu_state_list`, `git_log`/`git_diff`/`git_status`/`git_clone_ro`) as a typed MCP server — render charts, preview plans, read git history. Never applies or mutates. Requires `bun` on PATH. | local `plugins-cc/infra-tools/`                                                               |

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

Installs skills to `~/.agents/skills/`, rules to `~/.agents/rules/`, OpenCode plugins to
`~/.config/opencode/plugins/`, executable tools to `~/.local/bin/` with a Claude mirror in
`~/.claude/tools/`, and every `instructions/*.md` prompt to
`~/.agents/instructions/`. The global installer wires every instruction file into Codex
(`~/.codex/config.toml` — concatenated into `developer_instructions`), Claude Code
(`~/.claude/CLAUDE.md` — one markered block per file), and OpenCode
(`~/.config/opencode/opencode.json` — one entry per file in `instructions[]`) idempotently. Skills
and plugins are auto-discovered by OpenCode from its standard global directories.

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

### Tools

Global installs place tools on `~/.local/bin/` and preserve a mirror in `~/.claude/tools/`.

| Tool                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **bounded-run**       | Runs one direct-argv workload in the bounded `agent-work.slice` systemd user service |
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

Project-only installs expose the runner as `./.claude/tools/bounded-run`. The Claude plugin bundles
it at `$CLAUDE_PLUGIN_ROOT/tools/bounded-run`, and its hook reports that resolved path when denying
an unbounded command. Global installs expose `bounded-run` through `~/.local/bin`.

## Configuration

Agentkit uses a YAML config file at `~/.config/agentkit/config.yaml` (respects `XDG_CONFIG_HOME`).
The installer creates a default config from `config.example.yaml` on first run.

```yaml
git-police:
  branch-protection:
    allowed-repos:
      - brain
      - my-notes
```

### git-police.branch-protection.allowed-repos

Repos listed here are exempt from branch protection rules (direct commits/pushes to main/master
are allowed). Use the repo name (e.g. `brain`) or `owner/name` (e.g. `myorg/brain`). Partial
matches are supported.

### coding-police

All thresholds are configurable:

| Setting                | Default | Description                                              |
| ---------------------- | ------- | -------------------------------------------------------- |
| `max-file-lines`       | 1000    | Files exceeding this trigger a split warning             |
| `max-function-lines`   | 100     | Functions exceeding this trigger a decompose warning     |
| `min-duplicate-lines`  | 6       | Minimum identical consecutive lines to flag as duplicate |
| `max-exports-per-file` | 15      | Exports exceeding this trigger a responsibility warning  |
| `exclude-patterns`     | `[]`    | File path substrings to skip (e.g. `generated/`)         |

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
