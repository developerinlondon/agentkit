# agent-skills

Reusable AI agent skills and plugins for OpenCode, Claude Code, and other AI coding agents.

## What's Included

### Skills (SKILL.md -- works everywhere via skills.sh)

| Skill | Description |
|-------|-------------|
| **gitops-master** | GitOps operations for ArgoCD + Kargo: diagnose, verify, promote, setup |
| **autonomous-workflow** | Proposal-first development, commit hygiene, decision authority |
| **code-quality** | Warnings-as-errors, no underscore prefixes, test coverage |
| **documentation** | ASCII diagrams, structured plan format, formatting rules |
| **issue-raiser** | GitLab issue creation with root cause analysis and git-history-based assignees |

### Plugins (OpenCode only -- runtime hooks)

| Plugin | Description |
|--------|-------------|
| **version-check.ts** | Auto-checks Helm/npm/Cargo dependency versions on file write |
| **dprint-autoformat.ts** | Auto-formats files on write using dprint |

## Installation

### Option 1: skills.sh CLI (skills only, all agents)

```bash
npx skills add developerinlondon/agent-skills
```

This installs SKILL.md files for your AI agent (Claude Code, OpenCode, Cursor, etc.).

### Option 2: Install globally (all projects)

```bash
git clone git@github.com:developerinlondon/agent-skills.git
./agent-skills/install.sh --global
```

Installs skills to `~/.agents/skills/` where both OpenCode and Claude Code auto-discover them.

### Option 3: Install into a specific project

```bash
./agent-skills/install.sh /path/to/your/project
```

Copies skills + OpenCode plugins into the project's `.opencode/` directory.

### Option 4: Manual

Copy what you need:

```bash
cp -r skills/gitops-master/ your-project/.opencode/skills/
cp plugins/version-check.ts your-project/.opencode/plugins/
```

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
OpenCode's `tool.execute.after` event to run automatically when you edit/write files.

**version-check.ts**: Checks if Helm chart dependencies, npm packages, or Cargo crates are outdated
whenever you modify a `Chart.yaml`, `package.json`, or `Cargo.toml`.

**dprint-autoformat.ts**: Auto-formats files after every write/edit using dprint. Auto-discovers the
dprint binary from PATH or mise.

## Contributing

1. Skills follow the [skills.sh](https://skills.sh) / [agentskills.io](https://agentskills.io) standard
2. Each skill lives in `skills/<name>/SKILL.md` with optional `references/` and `scripts/` subdirs
3. Plugins live in `plugins/<name>.ts` and implement the OpenCode plugin API
