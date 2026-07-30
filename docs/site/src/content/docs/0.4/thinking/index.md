---
title: Thinking in agentkit
description: Judgment, not API reference — when a piece of working discipline
  should be a skill, a rule, a hook or a tool, and the principles that keep the
  kit honest.
sidebar:
  order: 1
slug: 0.4/thinking
---

No API here. This page is about judgment: when a piece of discipline should be a skill, a rule, a
hook or a tool, and the principles that keep the kit honest.

## Start from what you repeat

Everything in agentkit began as an instruction someone wrote more than twice — in one harness's
config, then another's, then a third's, each drifting on its own schedule. The kit exists to hold
_one_ copy.

So the first question is never "which mechanism". It is: **what do I keep repeating, and what
happens when an agent ignores it?**

The answer to the second half picks the surface.

## The surface ladder

Climb only as high as the failure justifies. Every step up trades reach for force and costs more
to maintain.

| Surface   | Use it when                                                     | Ignored on a Friday evening, the result is  |
| --------- | --------------------------------------------------------------- | ------------------------------------------- |
| **skill** | the knowledge is a _workflow_ — how to review, publish, diagram | worse work                                  |
| **rule**  | the knowledge must be present _before writing starts_           | bad habits land, and show up in review      |
| **hook**  | "please don't" has already failed                               | nothing — refusing happens at the tool call |
| **tool**  | refusing is not enough; the capability itself must be different | nothing — the limit is in the kernel        |

**A skill** when the agent should choose when it applies. If skipping it merely produces worse
work, stop here.

**A rule** when comment discipline or coding standards must be in context before the first line is
written, and a file glob can say when it applies. Rules arrive on their own; they are still advice.

**A hook** for force pushes, unbounded builds, stacked merge requests. If the action must not
happen, it has to be refused at the tool call, where forgetting is not possible.

**A tool** when the capability itself must change. `bounded-run` does not ask a build to be
polite; it makes exceeding the cgroup impossible.

:::tip[The test]
Imagine the instruction silently ignored on a Friday evening. If the answer is "annoying", write a
skill or a rule. If the answer is "we lost work / the host went down / an unreviewed change
shipped", it is a hook or a tool.
:::

## Enforce the floor, not the ceiling

Hooks encode the _minimum_ — the things that must never happen. They do not try to make the agent
good, only to make the worst outcomes unreachable.

That is why there are twelve police units and not a hundred. Every hook is a tax on every tool
call, and a hook that fires wrongly teaches agents to route around the whole system. The quality
ceiling lives in skills and rules, where being wrong is cheap.

## A refusal must redirect

Every police message names what to do instead: the worktree command to run, the `bounded-run`
invocation, the override variable for the legitimate exception.

This is a design rule, not a courtesy — an agent that hits a wall with no door will try every
other wall. A refusal that does not say what to do instead is treated as a bug in the kit.

```text
BLOCKED: 'npm install' is not allowed. Use bun instead. Mapping: npm install → bun install,
npm run → bun run, npm test → bun test, npm init → bun init, npx → bunx.
Override (only when the user approves npm): prefix with AGENTKIT_ALLOW_PKG=1.
```

Refusal, mapping, override. All three, every time.

## Consent is recorded, not assumed

Anything with teeth is opt-in and remembered.

The `strict-review` group installs only on a literal `--with strict-review` — the interactive
picker never offers it and `--all` excludes it. Deselecting it removes its artifacts. Overrides are
explicit environment variables an operator sets on **one command**, never config you set and
forget.

The kit never infers permission from the fact that something is already installed. Presence
without recorded selection is not consent.

## Trust the path, not the name

Anything can be called `bounded-run`. `resource-police` therefore trusts the runner by its
**installed path**, not by its name — otherwise a shell function or a local script called
`bounded-run` could silently neuter every limit, and the denial message would congratulate it.
`AGENTKIT_ALLOW_DELEGATED=1` does not clear that particular refusal.

The same reasoning shapes the merge gate: it resolves the head SHA from the forge, not from the
review record, and reads policy from the **target** commit rather than the source checkout. A
change must not be allowed to weaken the rules that judge it.

## Say plainly what it is not

- The review gate is **not security**. The record lives in the repository and a determined agent
  can forge it. Only forge-side required approvals actually prevent a merge. What the gate does
  buy is that a _stale_ review cannot be merged past.
- Codex policies match literal argv prefixes. They cannot see into shell payloads.
- Containment excludes delegated workloads — `docker`, `podman`, `ssh`, `systemd-run` — by design,
  because the child work can escape the transient cgroup.
- Hooks are guards, not a sandbox. They match patterns in tool calls and refuse. An effect written
  a different way is not caught by a guard that did not match it.

agentkit documents its own limits because a guard you wrongly believe in is worse than no guard:
you stop watching.

## Next

- [Four surfaces](/docs/0.4/concepts/four-surfaces/) — the mechanics behind the ladder above.
- [Police hooks](/docs/0.4/concepts/police-hooks/) — every unit, what it checks, how to override it.
- [Cookbook](/docs/0.4/cookbook/) — the recipes these principles produce.
- [Install](/docs/0.4/getting-started/install/) — if you have not got it on a machine yet.
