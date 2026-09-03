---
title: Write a police unit
weight: 1
---

A unit is a policy, not a file. Adding one means writing it once per mechanism that can express it,
and registering the hook so the harness runs it.

{{< callout type="info" >}}
Before writing a hook, check whether the discipline belongs at a lower altitude. A preference of
yours is a [taste](/guide/concepts/tastes/) — which can already refuse, with no code at all. A
workflow is a [skill](/guide/concepts/skills/). Only reach for a unit when "please don't" has already
failed. [Thinking in agentkit](/guide/thinking/) is the ladder.
{{< /callout >}}

## The anatomy of one

Every hook is an ordinary program: JSON on stdin, a decision on stdout.

```bash
#!/usr/bin/env bash
# example-police.sh — Claude Code PreToolUse hook (matcher: Bash)
# Blocks: <the one thing this refuses>
set -euo pipefail

# shellcheck source=lib/hook-input.sh
source "${BASH_SOURCE[0]%/*}/lib/hook-input.sh"
agentkit_slurp_input
COMMAND=$(agentkit_command)

[[ -z "$COMMAND" ]] && exit 0

deny() {
  agentkit_deny_json "$1"
  exit 0
}

if <the condition>; then
  deny "BLOCKED: <what happened>.

<why it is refused, in one line>

<what to do instead — the actual command>
Override (only when the user approves): prefix with AGENTKIT_ALLOW_EXAMPLE=1."
fi
```

Five things in that skeleton are load-bearing:

| Line                            | Why                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `set -euo pipefail`             | a hook that dies mid-way emits no decision, and no decision means allow                            |
| `source lib/hook-input.sh`      | reads both Claude's `tool_name` and Grok's `toolName` spellings                                    |
| `[[ -z "$COMMAND" ]] && exit 0` | a payload with no command is not this unit's business                                              |
| `agentkit_deny_json`            | emits both harnesses' deny shapes in one object                                                    |
| `exit 0` after denying          | **`PreToolUse` refuses by data, not by status** — a non-zero exit is a crash, which reads as allow |

## Write the refusal first

A refusal that does not say what to do instead is treated as a bug in the kit. Every message carries
three parts:

{{% steps %}}

### Refusal

What was blocked, quoting the offending fragment so the agent can see which part matched.

### Redirection

The command to run instead — literally, not a description of it. `issue-police` goes as far as
printing the accepted `Disposition:` forms.

### Override

The named variable, inline on one command. If a unit deliberately has none, say so in the message
rather than leaving the reader to guess.

{{% /steps %}}

## Parsing the command safely

Two traps have caught this kit before, and the existing units show the fix.

**Quoted text is not a command.** A commit message that _mentions_ `gh issue create` is not a
creation. `issue-police` empties quoted strings before matching the trigger, then searches the
original text for the body:

```bash
STRIPPED=$(echo "$COMMAND" |
  sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g" |
  sed -E "s/'[^']*'/''/g")
```

**A relative path resolves against the command's own `cd`, not yours.** The payload carries no
reliable working directory, so a unit that reads a file named in the command has to honour a
`cd <path>` prefix the command itself carries.

## Register it

Add an entry to `hooks/claude/settings.json` under the matching event. The installer merges this
whole `hooks` object into `~/.claude/settings.json`.

```json
{
  "type": "command",
  "command": "$HOME/.claude/hooks/example-police.sh",
  "timeout": 10,
  "statusMessage": "example-police: checking …"
}
```

| Field           | Guidance                                                                      |
| --------------- | ----------------------------------------------------------------------------- |
| `matcher`       | `Bash` for commands, `Edit\|Write` for file writes, a regex for tool families |
| `timeout`       | 10s is the norm; raise it only when the unit asks a network service           |
| `statusMessage` | what the user sees while it runs                                              |

Wrap it in `fail-closed-hook.sh <budget>` only if its **silence** should be a denial. That is true of
the merge gate and nothing else so far — every other unit fails open, loudly.

The generated tables on this site read that same file, so registering a unit is what puts it in the
[hooks reference](/reference/hooks/).

## The other mechanisms

| Mechanism | File                                 | Notes                                                                             |
| --------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| OpenCode  | `plugins/<name>-police.ts`           | advisory by convention — appends findings to the tool output rather than throwing |
| Codex     | `policies/codex/<name>-police.rules` | matches **literal argv prefixes**; it cannot parse shell                          |

Where the Codex policy cannot express a narrow rule, make it **broader** and say so, rather than
shipping something that looks precise and is not. `delegation-police` is the worked example: it
refuses whole classes outright on Codex while the hook and plugin do real payload analysis.

A unit does not have to exist in all three. Coverage is uneven on purpose, and the
[coverage table](/reference/hooks/#coverage) is generated from which files exist.

## Test it

```sh
printf '{"tool_name":"Bash","tool_input":{"command":"<the bad command>"}}' \
  | ./hooks/claude/example-police.sh; echo "exit=$?"
```

Assert **both** halves: a denial prints JSON at exit 0, an approval prints nothing at exit 0. A test
that only checks the deny path passes just as happily against a hook that refuses everything.

Then mutate the input, not only the guard: confirm the near-miss command it should _allow_ still
comes back silent.
