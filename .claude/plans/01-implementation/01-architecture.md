# Agentkit — Architecture

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          agentkit.sbs                                   │
│                                                                         │
│  Astro static site on Cloudflare Pages                                  │
│  Landing, docs, skill registry (JSON index from GitHub API)             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                    install script / docs
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
     ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
     │ curl | sh      │ │ brew install │ │ cargo install    │
     │ (binary)       │ │ (tap)        │ │ (source)         │
     └───────┬────────┘ └──────┬───────┘ └────────┬─────────┘
             │                 │                   │
             └─────────────────┼───────────────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │        agentkit binary         │
              │        (single Rust bin)       │
              │                                │
              │  install / update / add / rm   │
              │  doctor / config / self-update │
              │  hook <name>                   │
              └───────────────┬────────────────┘
                              │
               ┌──────────────┼──────────────┐
               │              │              │
               ▼              ▼              ▼
        ┌────────────┐ ┌───────────┐ ┌────────────┐
        │ Claude Code│ │ OpenCode  │ │ Codex CLI  │
        │            │ │           │ │            │
        │ settings   │ │ plugin    │ │ .rules     │
        │ .json hook │ │ shim .ts  │ │ shim       │
        │ calls:     │ │ calls:    │ │ calls:     │
        │ agentkit   │ │ agentkit  │ │ agentkit   │
        │ hook ...   │ │ hook ...  │ │ hook ...   │
        └────────────┘ └───────────┘ └────────────┘
```

---

## Binary Internals

```
┌──────────────────────────────────────────────────────────────┐
│                     agentkit binary                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    CLI (clap)                           │  │
│  │                                                        │  │
│  │  install  update  add  remove  list  doctor  config    │  │
│  │  self-update  hook                                     │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────┼────────────────────────────────┐  │
│  │                  Core Modules                          │  │
│  │                                                        │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐ │  │
│  │  │ config   │  │ registry │  │ installer            │ │  │
│  │  │          │  │          │  │                      │ │  │
│  │  │ serde    │  │ GitHub   │  │ skills → dest dirs   │ │  │
│  │  │ _yaml    │  │ API for  │  │ hooks → platform     │ │  │
│  │  │ reader   │  │ skill    │  │         shims        │ │  │
│  │  │          │  │ discovery│  │ rules → auto-load    │ │  │
│  │  │ XDG      │  │          │  │ config → XDG dir     │ │  │
│  │  │ paths    │  │ Local    │  │ settings.json merge  │ │  │
│  │  │          │  │ index    │  │                      │ │  │
│  │  └──────────┘  └──────────┘  └──────────────────────┘ │  │
│  │                                                        │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │ hooks (native implementations)                   │  │  │
│  │  │                                                  │  │  │
│  │  │ git-police     format-police    kubectl-police   │  │  │
│  │  │                                                  │  │  │
│  │  │ All hooks read config.yaml via config module.    │  │  │
│  │  │ Stdin: JSON (Claude) or structured (OpenCode).   │  │  │
│  │  │ Stdout: deny/allow decision.                     │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Hook Execution Flow

```
Agent tool call (e.g. git push --force)
          │
          ▼
┌──────────────────────┐
│ Platform hook/plugin │    Claude Code: settings.json PreToolUse
│ (thin shim)          │    OpenCode: plugin .ts tool.execute.before
│                      │    Codex CLI: .rules file
└──────────┬───────────┘
           │
           │  stdin: tool input JSON
           │
           ▼
┌──────────────────────┐
│ agentkit hook <name> │    Single Rust binary
│                      │
│ 1. Parse stdin       │
│ 2. Load config.yaml  │
│ 3. Check allowlist   │
│ 4. Evaluate rules    │
│ 5. Return decision   │
└──────────┬───────────┘
           │
           │  stdout: allow (exit 0) or deny (JSON)
           │
           ▼
┌──────────────────────┐
│ Agent proceeds or    │
│ gets blocked         │
└──────────────────────┘
```

---

## Config System

```
~/.config/agentkit/
├── config.yaml             User configuration (hooks, allowlists, preferences)
└── registry-cache.json     Cached skill index from agentkit.sbs (auto-refreshed)
```

All config access goes through the `config` module using `serde_yaml`. No regex parsing, no
shell-based YAML readers. XDG_CONFIG_HOME respected.

---

## Platform Shim Examples

### Claude Code (settings.json)

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "agentkit hook git-police"
      }]
    }]
  }
}
```

### OpenCode (plugin .ts)

```typescript
export default async function gitPolice(ctx: PluginInput) {
  return {
    'tool.execute.before': async (input, output) => {
      const result = spawnSync('agentkit', ['hook', 'git-police'], {
        input: JSON.stringify({ tool: input.tool, args: output.args }),
        encoding: 'utf-8',
      });
      if (result.status !== 0) throw new Error(result.stdout);
    },
  };
}
```

---

## npm Shim Architecture

Follows the esbuild/turbo/biome pattern:

```
agentkit (root package)
├── package.json
│   └── optionalDependencies:
│       ├── @agentkit/linux-x64
│       ├── @agentkit/linux-arm64
│       ├── @agentkit/darwin-x64
│       └── @agentkit/darwin-arm64
└── bin/agentkit.js          Resolves platform package, execs binary

@agentkit/linux-x64
└── bin/agentkit             Prebuilt Rust binary for Linux x64

@agentkit/darwin-arm64
└── bin/agentkit             Prebuilt Rust binary for macOS ARM64
```

npm installs only the matching platform package via `os` + `cpu` fields in each
sub-package's `package.json`.

---

## Website Architecture

```
agentkit.sbs (Cloudflare Pages)
│
├── / (landing)              Hero + install command + feature grid
├── /docs/                   Installation, config, skill authoring, plugin API
├── /skills/                 Skill registry (filterable list)
├── /changelog/              Auto-generated from GitHub releases
│
└── Build pipeline:
    GitHub push → Cloudflare Pages build → Astro SSG
    Skill index: GitHub API query at build time → skills.json
```
