# Agentkit — Plan

> **Created:** 2026-02-21 | **Status:** Planning | **Repo:** github.com/developerinlondon/agentkit
> **Binary:** `agentkit` | **Domain:** agentkit.sbs | **npm:** `agentkit` (dispute pending)
>
> **All estimates are AI agent time** (16h/day throughput, ~4x human speed).

See 01-architecture.md for system design and binary internals. See 02-file-structure.md for repo
layout. See 03-roadmap.md for implementation sprints.

---

## Problem Statement

AI agent guardrails (hooks, plugins, rules, skills) are currently distributed as loose files copied
by a shell script. Each target platform (Claude Code, OpenCode, Codex CLI) needs its own format,
leading to triplicated logic (bash, TypeScript, Starlark). Installation requires cloning a git repo
and running `install.sh`. There's no update mechanism, no health checks, and no way to install
individual skills from third-party repos.

---

## What Makes This Unique

| Aspect        | Current (install.sh)            | Agentkit CLI                               |
| :------------ | :------------------------------ | :----------------------------------------- |
| Installation  | `git clone` + `./install.sh`    | `curl \| sh` or `brew install`             |
| Updates       | Manual `git pull` + re-run      | `agentkit update` / `agentkit self-update` |
| Hook logic    | 3 copies (bash + TS + starlark) | Single Rust binary, all platforms call it  |
| Config        | Regex YAML parsing in bash/TS   | Native `serde_yaml`                        |
| Skill install | All-or-nothing                  | `agentkit add <skill>` individual install  |
| Third-party   | Not supported                   | `agentkit add user/repo`                   |
| Health check  | None                            | `agentkit doctor`                          |
| Testing       | Hope the shell script works     | Rust unit + integration tests              |

---

## Target Users

1. **AI agent operators** — developers using OpenCode, Claude Code, Cursor, Codex CLI who need
   guardrails (git-police, format-police, kubectl-police) installed across all their tools
2. **Skill authors** — developers publishing reusable agent skills for the community
3. **Teams** — organizations standardizing agent behavior across developers

---

## Phase 1: Rust CLI Binary

### Goal

A single binary (`agentkit`) that replaces `install.sh` and adds skill/plugin management.
All hook/plugin logic moves into the binary — platform-specific formats become thin shims that
call `agentkit hook <name>`.

### Native Hook Migration

Instead of maintaining separate implementations per platform:

```
Current:                              After:
~/.claude/hooks/git-police.sh         agentkit hook git-police < stdin
~/.agents/plugins/git-police.ts       agentkit hook git-police < stdin
~/.codex/rules/git-police.rules       agentkit hook git-police < stdin
```

Each platform's hook file becomes a one-liner shim calling the binary. One implementation, one test
suite, one config reader. The binary reads `~/.config/agentkit/config.yaml` natively via
`serde_yaml`.

### Commands

```
agentkit install                      Install all skills/plugins/hooks globally
agentkit install --project            Install into current project
agentkit update                       Pull latest + reinstall
agentkit self-update                  Update the binary itself
agentkit list                         List installed skills, plugins, rules
agentkit add <skill>                  Install a single skill
agentkit add <user/repo>              Install from third-party repo
agentkit remove <skill>               Remove a skill
agentkit config                       Show config path and contents
agentkit doctor                       Verify installation health
agentkit hook <name>                  Execute a hook (called by platform shims)
```

### Build Targets

| Target                      | Platform            |
| :-------------------------- | :------------------ |
| `x86_64-unknown-linux-gnu`  | Linux x64           |
| `aarch64-unknown-linux-gnu` | Linux ARM64         |
| `x86_64-apple-darwin`       | macOS Intel         |
| `aarch64-apple-darwin`      | macOS Apple Silicon |

### Distribution Channels

1. **Direct download** — `curl -fsSL https://agentkit.sbs/install | sh`
2. **Homebrew** — `brew install developerinlondon/tap/agentkit`
3. **Cargo** — `cargo install agentkit`

---

## Phase 2: npm Package Dispute + Shim

### Goal

Claim `agentkit` on npm. Provide `npx agentkit` as an alternative install path.

### npm Name Dispute

The `agentkit` package on npm is squatted (empty 0.0.0 by tejaskumar).

**Steps:**

1. File npm dispute at https://npmjs.com/support — cite active project, GitHub repo, website
2. If dispute fails, fall back to `@agentkit/cli`

### npm Shim Package

Once secured, publish a thin npm package that downloads the correct Rust binary for the platform.
Follows the pattern used by esbuild, turbo, and biome — npm is just a platform-specific binary
wrapper using `optionalDependencies`.

Packages: `@agentkit/linux-x64`, `@agentkit/linux-arm64`, `@agentkit/darwin-x64`,
`@agentkit/darwin-arm64`, root `agentkit` package.

---

## Phase 3: agentkit.sbs Website

### Goal

Landing page + docs + skill registry at agentkit.sbs.

### Sections

1. **Landing page** — what agentkit is, one-liner install, feature highlights
2. **Docs** — installation, configuration, skill authoring guide, plugin API
3. **Skill registry** — browse available skills (pulled from GitHub repos at build time)
4. **Changelog** — release notes

### Tech Stack

- Static site generator (Astro)
- Hosted on Cloudflare Pages (pairs with .sbs domain on Cloudflare)
- Content from markdown files in repo (docs-as-code)
- Skill registry: JSON index generated from GitHub API at build time

---

## Open Questions

- Should the skill registry be centralized (agentkit.sbs index) or decentralized (GitHub search)?
- What's the versioning strategy for the CLI vs the skills?
- Should `agentkit add` support installing from GitLab as well as GitHub?
