# Plan: Agentkit Distribution & Website

## Overview

Agentkit needs a proper distribution story — a website at agentkit.sbs, a Rust CLI binary for
install/manage, and npm package ownership for the `agentkit` name.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      agentkit.sbs                           │
│                                                             │
│  Landing page, docs, skill registry, install instructions   │
│  Static site (Astro/Hugo) hosted on Cloudflare Pages        │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
              ▼           ▼           ▼
     ┌────────────┐ ┌──────────┐ ┌──────────────┐
     │ Binary CLI │ │ npm pkg  │ │ GitHub Repo  │
     │ (Rust)     │ │ (shim)   │ │ (source)     │
     │            │ │          │ │              │
     │ curl/brew  │ │ npx      │ │ git clone +  │
     │ install    │ │ agentkit │ │ install.sh   │
     └────────────┘ └──────────┘ └──────────────┘
```

---

## Phase 1: Rust CLI Binary

### Goal

A single binary (`agentkit`) that replaces `install.sh` and adds skill/plugin management.

### Commands

```
agentkit install              # Install all skills/plugins/hooks globally
agentkit install --project    # Install into current project
agentkit update               # Pull latest from repo + reinstall
agentkit list                 # List installed skills, plugins, rules
agentkit add <skill>          # Install a single skill (e.g. agentkit add gitops-master)
agentkit remove <skill>       # Remove a skill
agentkit config               # Open/show ~/.config/agentkit/config.yaml
agentkit doctor               # Verify installation health (paths, hooks, config)
```

### Build Targets

- `x86_64-unknown-linux-gnu` (Linux x64)
- `aarch64-unknown-linux-gnu` (Linux ARM64)
- `x86_64-apple-darwin` (macOS Intel)
- `aarch64-apple-darwin` (macOS Apple Silicon)

### Distribution Channels

1. **Direct binary download** (GitHub Releases)
   - Curl one-liner: `curl -fsSL https://agentkit.sbs/install | sh`
   - Downloads correct binary for platform, places in `~/.local/bin/` or `/usr/local/bin/`

2. **Homebrew tap**
   - `brew install developerinlondon/tap/agentkit`

3. **Cargo install** (for Rust users)
   - `cargo install agentkit` (publish to crates.io)

### Implementation Notes

- Use `clap` for CLI arg parsing
- Use `reqwest` for HTTP (downloading skills from registries)
- Use `serde_yaml` for config parsing
- Embed `install.sh` logic in Rust — no shell dependency
- GitHub Actions CI for cross-compilation (use `cross-rs` or `cargo-zigbuild`)
- Self-update mechanism: `agentkit self-update`

### Tasks

- [ ] Scaffold Rust project (`cargo init packages/cli`)
- [ ] Implement `install` command (port install.sh logic)
- [ ] Implement `list` / `add` / `remove` commands
- [ ] Implement `doctor` command
- [ ] Implement `config` command
- [ ] Set up cross-compilation CI (GitHub Actions)
- [ ] Create install script (`curl | sh` one-liner)
- [ ] Publish to crates.io
- [ ] Create Homebrew tap formula
- [ ] Add self-update mechanism

---

## Phase 2: npm Package Dispute & Shim

### Goal

Claim `agentkit` on npm. Provide `npx agentkit` as an alternative install path.

### npm Name Dispute

The `agentkit` package on npm is squatted (empty 0.0.0 by tejaskumar).

**Steps:**

- [ ] File npm dispute at https://npmjs.com/support — cite trademark/project use
- [ ] Reference: GitHub repo (developerinlondon/agentkit), website (agentkit.sbs), active development
- [ ] If dispute fails, fall back to `@agentkit/cli` or `agent-kit`

### npm Shim Package

Once the name is secured, publish a thin npm package that:

1. Downloads the correct Rust binary for the platform
2. Places it in `node_modules/.bin/agentkit`
3. Proxies all commands to the binary

This follows the pattern used by `esbuild`, `turbo`, `biome` — npm package is just a platform-specific
binary wrapper.

### Tasks

- [ ] File npm dispute for `agentkit` package name
- [ ] Create npm package structure with platform-specific optionalDependencies
- [ ] Publish platform packages (`@agentkit/linux-x64`, `@agentkit/darwin-arm64`, etc.)
- [ ] Publish root `agentkit` package with postinstall binary download
- [ ] Test `npx agentkit install` flow

---

## Phase 3: agentkit.sbs Website

### Goal

Landing page + docs + skill registry at agentkit.sbs.

### Sections

1. **Landing page** — What agentkit is, one-liner install, feature highlights
2. **Docs** — Installation, configuration, skill authoring guide, plugin API
3. **Skill registry** — Browse available skills (pulled from GitHub repos)
4. **Blog/changelog** — Release notes, guides

### Tech Stack

- Static site generator (Astro or Hugo)
- Hosted on Cloudflare Pages (pairs with .sbs domain on Cloudflare)
- Content from markdown files in repo (docs-as-code)
- Skill registry: JSON index file generated from GitHub API at build time

### Tasks

- [ ] Register agentkit.sbs domain
- [ ] Set up Cloudflare Pages project
- [ ] Scaffold site with Astro
- [ ] Create landing page with install instructions
- [ ] Create docs pages (install, config, skill authoring, plugin API)
- [ ] Create skill registry page (pull from GitHub)
- [ ] Set up CI to auto-deploy on push to main
- [ ] Add OG images / social cards

---

## Priority Order

1. **Phase 1** (Rust CLI) — Core distribution mechanism, replaces install.sh
2. **Phase 2** (npm dispute + shim) — Parallel with Phase 1, dispute takes time
3. **Phase 3** (Website) — After CLI is functional, docs need something to document

## Open Questions

- Should the CLI support installing skills from third-party repos? (e.g. `agentkit add user/repo`)
- Should the skill registry be centralized (agentkit.sbs index) or decentralized (GitHub search)?
- What's the versioning strategy for the CLI vs the skills?
