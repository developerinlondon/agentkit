# AGENTS.md

## Critical: Proposal-First Workflow

**NEVER create, modify, or delete files without explicit user approval.** This includes:

- Creating new skills, tools, plugins, hooks, or policies
- Modifying existing files in this repo
- Installing anything globally (`~/.agents/`, `/usr/local/bin/`, systemd units, etc.)
- Removing or disabling system services, timers, or scripts

**Always:**

1. **Research** — Gather context, explore the codebase, understand what exists
2. **Propose** — Present a clear plan with what you'll create/modify/delete and why
3. **Wait** — Do NOT proceed until the user explicitly approves
4. **Implement** — Only after approval

**Exceptions:** Read-only operations (grep, file reads, status checks, exploration).

## What is Agentkit

Reusable AI agent skills, rules, plugins, hooks, and tools for OpenCode, Claude Code, Codex CLI,
and other AI coding agents.

- **Repo**: [github.com/developerinlondon/agentkit](https://github.com/developerinlondon/agentkit)
- **Stack**: Markdown (skills/rules), TypeScript (OpenCode plugins), Bash (Claude hooks), Starlark (Codex policies)

## Structure

```
agentkit/
├── skills/           # SKILL.md files — works everywhere via skills.sh
├── rules/            # Auto-loaded by file glob match (OpenCode)
├── plugins/          # OpenCode-only TypeScript runtime hooks
├── hooks/            # Claude Code bash hook scripts
├── policies/         # Codex CLI Starlark .rules files
├── tools/            # Standalone scripts (Python/Bash)
├── tests/            # Test scripts
├── install.sh        # Installer for all platforms
└── config.example.yaml
```

## Skills Format

Skills live in `skills/<name>/SKILL.md` with YAML frontmatter:

```yaml
---
name: skill-name
description: >-
  One-paragraph description. Include trigger phrases for auto-discovery.
---
```

Body is Markdown — instructions for the AI agent. Can include:

- Decision trees, mode detection tables
- Command references, configuration
- Optional `references/` and `scripts/` subdirs

## Installation

```bash
# Global (all projects, all tools)
./install.sh --global

# Per-project
./install.sh /path/to/project

# Skills only (via skills.sh)
npx skills add developerinlondon/agentkit
```

## Key Skills

| Skill               | Description                                    |
| ------------------- | ---------------------------------------------- |
| autonomous-workflow | Proposal-first development, commit hygiene     |
| code-quality        | Warnings-as-errors, test coverage, type safety |
| documentation       | ASCII diagrams, structured plans               |
| gitops-master       | ArgoCD + Kargo operations                      |
| issue-raiser        | GitLab issue creation with root cause analysis |
| project-planning    | Structured project breakdown                   |

## Commands

```bash
# Install globally
./install.sh --global

# Install into project
./install.sh ~/code/my-project

# Test hooks/plugins manually
bash hooks/claude/git-police.sh <tool_name> <input_json>
```
