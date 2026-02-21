# agentkit

Reusable AI agent skills, rules, plugins, hooks, and tools for OpenCode, Claude Code, and other AI coding agents.

## What's Included

### Skills (SKILL.md -- works everywhere via skills.sh)

| Skill                   | Description                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| **gitops-master**       | GitOps operations for ArgoCD + Kargo: diagnose, verify, promote, setup                   |
| **autonomous-workflow** | Proposal-first development, commit hygiene, decision authority                           |
| **code-quality**        | Warnings-as-errors, no underscore prefixes, test coverage                                |
| **documentation**       | ASCII diagrams, structured plan format, formatting rules                                 |
| **issue-raiser**        | GitLab issue creation with root cause analysis and git-history-based assignees           |
| **project-planning**    | Structured project planning: break down ideas into architecture, file structure, roadmap |

### Rules (auto-loaded by file glob match)

| Rule                     | Glob               | Description                                                        |
| ------------------------ | ------------------ | ------------------------------------------------------------------ |
| **consent-protocol**     | `**/*`             | Stop after asking a question -- never act and ask in the same turn |
| **credential-bootstrap** | `gitops/**/*.yaml` | OpenBao + ESO credential bootstrap pattern for GitOps apps         |

### Plugins (OpenCode only -- runtime hooks)

| Plugin                | Description                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| **version-police.ts** | Auto-checks Helm/npm/Cargo dependency versions on file write                                       |
| **format-police.ts**  | Auto-formats files on write using dprint                                                           |
| **kubectl-police.ts** | Blocks kubectl create/apply for Kargo CRDs (unconditionally)                                       |
| **git-police.ts**     | Blocks commits to main/master, force push, --no-verify, AI attribution, push to protected branches |

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

Installs skills to `~/.agents/skills/`, rules to `~/.agents/rules/`, plugins to
`~/.agents/plugins/`, and tools to `~/.claude/tools/`. Skills are auto-discovered by OpenCode. For
global plugins, add `file://` entries to your opencode config (the installer prints the exact entries
to add).

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

### Tools (standalone scripts installed to ~/.claude/tools/)

| Tool                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **fix-ascii-boxes.py** | Fixes ASCII box-drawing alignment in markdown files, handles nested boxes inside-out |

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

**version-police.ts**: Checks if Helm chart dependencies, npm packages, or Cargo crates are outdated
whenever you modify a `Chart.yaml`, `package.json`, or `Cargo.toml`.

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

## Rules

Rules are auto-loaded by OpenCode when you edit files matching their glob pattern. Unlike skills
(which must be explicitly loaded), rules are always-on context.

**credential-bootstrap.md**: Activated when editing `gitops/**/*.yaml`. Provides the full OpenBao +
ESO credential bootstrap pattern -- 3 template files (presync-rbac, presync-bootstrap,
externalsecret) that auto-generate and manage secrets for any GitOps app.

## Contributing

1. Skills follow the [skills.sh](https://skills.sh) / [agentskills.io](https://agentskills.io) standard
2. Each skill lives in `skills/<name>/SKILL.md` with optional `references/` and `scripts/` subdirs
3. Rules live in `rules/<name>.md` with frontmatter globs for auto-loading
4. Plugins live in `plugins/<name>.ts` and implement the OpenCode plugin API
5. Tools live in `tools/<name>` and are standalone executable scripts (Python/Bash)
