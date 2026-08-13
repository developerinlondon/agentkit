---
title: Verify the install
weight: 2
---

A file listing tells you files were copied. It does not tell you the behaviour changed, and the
behaviour is the product. Worse, the failure this page exists to catch is *silent*: a
`PreToolUse` hook that crashes on its first line emits no decision, and **no decision means allow**.
A guard that is broken and a guard that approved look identical from the outside.

So verify in this order: the artifacts exist, the hook answers correctly when you drive it by hand,
and the harness refuses in a live session.

{{% steps %}}

### The artifacts are on disk

```sh
ls ~/.agentkit/skills          # {{< count coreSkills >}} core skills; more with optional kits
cat ~/.agentkit/kits           # the remembered kit selection
ls ~/.claude/settings.json     # must exist, or no Claude hook is registered
ls ~/.claude/hooks/            # symlinks into ~/.agentkit/hooks/
```

On Linux a core-only install also puts executables on `~/.local/bin`:

{{< tool-table >}}

The Linux-only entries are not merely skipped elsewhere. If a previous run left them on a macOS
box, the installer **removes** them — an installed binary that cannot enforce its limits is worse
than an absent one, because the refusals that reference it would be pointing at a lie.

{{< callout type="warning" >}}
`review-profile` and `review-gate` ship only with the `adversarial-review` kit, so they are absent
from a default install. Do not use them as a smoke test unless you passed
`--with adversarial-review`.
{{< /callout >}}

### The dependencies resolve

```sh
command -v jq dprint
```

Both matter, and each direction of failure is deliberate. Without `dprint`, `format-police` skips
with a warning — formatting enforcement is simply off. Without `jq`, most units allow the call.
`review-police` is the exception: it fails closed and refuses the merge. Neither state announces
itself while it is happening.

### Drive a hook by hand

This is the check that distinguishes "installed" from "working". A police hook is an ordinary
program: it reads one JSON object on stdin and answers on stdout.

{{< callout type="info" >}}
The payload carries no reliable working directory, so lockfile detection starts at the **hook
process's own** directory and stops at the git root. Run these from inside the project you want it
to judge, not from your home directory.
{{< /callout >}}

```sh
mkdir -p /tmp/probe && cd /tmp/probe && git init -q && echo '{}' > package-lock.json

printf '{"tool_name":"Bash","tool_input":{"command":"bun install left-pad"}}' \
  | ~/.claude/hooks/pkg-police.sh; echo "exit=$?"
```

A working guard answers with a denial, on stdout, **at exit 0**:

```json
{
  "decision": "deny",
  "reason": "BLOCKED: 'bun install' — this project uses npm (package-lock.json). Use 'npm add'. Override (only when the user approves): prefix with AGENTKIT_ALLOW_PKG=1.",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "BLOCKED: 'bun install' — this project uses npm (package-lock.json). Use 'npm add'. Override (only when the user approves): prefix with AGENTKIT_ALLOW_PKG=1."
  }
}
exit=0
```

One object carries both harnesses' deny shapes at once — a top-level `{decision, reason}` for Grok
and a `hookSpecificOutput` block for Claude Code — so a single script blocks in either.

Now confirm it is *judging* rather than blanket-refusing. The same unit must stay silent on a
command the project's own manager legitimately owns, and on a read-only query:

```sh
printf '{"tool_name":"Bash","tool_input":{"command":"npm install left-pad"}}' \
  | ~/.claude/hooks/pkg-police.sh; echo "exit=$?"   # empty output, exit=0 → allowed
printf '{"tool_name":"Bash","tool_input":{"command":"npm ls"}}' \
  | ~/.claude/hooks/pkg-police.sh; echo "exit=$?"   # empty output, exit=0 → allowed
```

{{< callout type="warning" >}}
**Read both halves of the answer.** Exit 0 with a JSON denial is a refusal; exit 0 with no output
is an approval. A hook that crashed also prints nothing — so an empty answer only means "allowed"
once you have seen the same script deny something.
{{< /callout >}}

### The harness actually refuses

The by-hand check proves the guard works. Only a live session proves it is *wired*.

Ask an agent in the installed client to run `npm install` in a project whose lockfile names another
manager. A working install refuses it. On OpenCode the message opens with:

```text
BLOCKED: 'npm install' is not allowed. Use bun instead.
```

The other surfaces word it differently and name the `AGENTKIT_ALLOW_PKG=1` override inline. That
refusal is the product.

{{% /steps %}}

## When a hook is mute

Silence reads as approval, so a hook that is not firing is more dangerous than one that fires
wrongly. Before assuming breakage, walk these in order:

| Check | How |
| --- | --- |
| Is it switched off? | `AGENTKIT_SKIP_HOOKS` takes a comma-separated list of unit names, or `all`, and short-circuits matching hooks at their first line |
| Is the unit config-gated? | `resource-police` and `delegation-police` enforce nothing until enabled in `config.yaml` |
| Is it registered? | `jq '.hooks.PreToolUse' ~/.claude/settings.json` — a unit removed with its kit is gone from here too |
| Is the link intact? | `ls -l ~/.claude/hooks/` — every entry should resolve into `~/.agentkit/hooks/` |
| Does it run at all? | drive it by hand as above; a crash prints a shell error rather than JSON |

Every switch and config key is in [configuration](/reference/configuration/); to override one guard
for one command, see [override a guard](/cookbook/override-a-guard/).
