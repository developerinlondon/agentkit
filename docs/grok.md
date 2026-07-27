# Grok CLI — agentkit install and enforcement

Agentkit supports [Grok CLI](https://github.com/xai-org/grok-cli) (Grok Build TUI)
through two layers: **always-on instructions/skills** and **Claude-compatible
lifecycle hooks**.

## Soft vs hard enforcement

| Layer | What it is | How Grok gets it | Blocks tools? |
| --- | --- | --- | --- |
| **Soft** | Rules, instructions, skills | `~/.grok/rules/*.md`, `~/.grok/skills/*` | No — model guidance only |
| **Hard** | Police hooks (git/resource/pkg/…) | Loaded from `~/.claude/settings.json` when `compat.claude.hooks` is on (default) | Yes — PreToolUse deny |

`grok inspect` listing hooks under `Hooks` means they are **registered**, not that
they enforced the last command. After install, verify with the probe below.

## Install

```bash
git clone git@github.com:developerinlondon/agentkit.git
cd agentkit
./install.sh --global
```

What that does for Grok specifically:

1. **Claude hooks** land in `~/.claude/hooks/` (including `lib/hook-input.sh`) and
   are merged into `~/.claude/settings.json`. Grok loads those hooks by default
   (`[compat.claude] hooks = true`).
2. On Linux, **tools** land on `PATH` as `bounded-run` / `agentkit-run`. The
   installer omits them on non-Linux hosts, where their systemd cgroup boundary
   cannot run.
3. **Instructions / skills / rules** for Grok depend on the installer revision:
   - Current `main` + shared-root install (see PR that introduces
     `~/.agentkit/`): per-name symlinks under `~/.grok/skills` and
     `~/.grok/rules`, including always-on instructions as rules.
   - If your install predates that, copy or symlink rules/skills manually, or
     re-run a shared-root global install.

Restart Grok (or start a new session) after install so hooks reload.

### Confirm

```bash
grok inspect | sed -n '/Hooks/,/Config Sources/p'
# Expect git-police, resource-police, format-police, etc. tagged [claude]

# Functional probe (must DENY on both shapes after this fix):
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | ~/.claude/hooks/git-police.sh
echo '{"toolName":"run_terminal_command","toolInput":{"command":"git push --force origin main"}}' \
  | ~/.claude/hooks/git-police.sh
```

Both must print a deny JSON with `decision: "deny"` **and**
`hookSpecificOutput.permissionDecision: "deny"`.

### Optional: disable Claude harness scan

Only if you intentionally do not want Grok to load Claude hooks/skills:

```toml
# ~/.grok/config.toml
[compat.claude]
hooks = false
skills = false
```

## Payload contract (why hooks used to fail open)

| Harness | Tool name examples | Stdin keys |
| --- | --- | --- |
| Claude Code | `Bash`, `Edit`, `Write` | `tool_name`, `tool_input`, `session_id` |
| Grok CLI | `run_terminal_command`, `search_replace`, `write` | `toolName`, `toolInput`, `sessionId` |

Grok **matcher** aliases map Claude names onto Grok tools, so a settings entry
with `matcher: "Bash"` still fires on `run_terminal_command`. Scripts must still
read **both** key styles and treat Grok tool names as Bash/Edit/Write families.
That logic lives in `hooks/claude/lib/hook-input.sh`.

Deny responses dual-emit:

```json
{
  "decision": "deny",
  "reason": "…",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "…"
  }
}
```

## Resource bounding on Grok

On Linux, `resource-police` requires `bounded-run` the same way as on Claude.
Grok does not rewrite the agent’s shell command; the model (and soft rules) must
use `bounded-run --profile … -- <cmd>`. The hook only **denies** unbounded heavy
commands. Linux host requirements are cgroup v2, `agent-work.slice`, and matching
`/etc/agentkit/resource-guard.conf`.

On non-Linux hosts, local heavy-command containment stands down. Delegation
analysis remains active when the Claude-compatible hook can load `jq`, `awk`,
and `cat`; if one is missing, the hook warns and intentionally fails open. See
`skills/resource-safe-execution/`.

## Related

- Review / merge gate: [docs/review-process.md](./review-process.md)
- Issue: Grok fail-open gap (payload keys) — tracked with the dual-payload PR
