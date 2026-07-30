---
title: Rules and instructions
description: The two always-loaded instruction layers, how they reach each client, and what agentkit does not enforce about them.
sidebar:
  order: 4
---

Skills load on demand. Rules and instructions are the layers that are already there — the context an
agent has before it decides anything.

| Layer                            | Loaded when                | Scoped by                   | Lives in        |
| -------------------------------- | -------------------------- | --------------------------- | --------------- |
| Rules                            | a matching file is in play | a glob in the frontmatter   | `rules/`        |
| Instructions                     | every session              | nothing — always on         | `instructions/` |
| [Skills](/docs/concepts/skills/) | the agent invokes one      | its own trigger description | `skills/`       |

## Rules: markdown with a glob

Five rules ship, each a markdown file whose frontmatter carries a `globs` key:

| Rule                      | Glob covers                                      |
| ------------------------- | ------------------------------------------------ |
| `coding-standards.md`     | 19 source-file extensions                        |
| `comment-discipline.md`   | the same, plus shell, YAML, TOML and Dockerfiles |
| `consent-protocol.md`     | everything                                       |
| `issue-tracking.md`       | everything                                       |
| `credential-bootstrap.md` | `gitops/**/*.{yaml,yml}`                         |

:::caution[The glob is read by the client, not by agentkit]
No script in the kit parses that frontmatter key. Glob auto-loading is documented OpenCode
behaviour. The installer also links rules into the Claude and Grok rule directories, and the kit
makes **no claim** that those clients honour the pattern — Grok's rules directory loads always-on
rather than glob-gated. If you depend on a rule being scoped, verify your client scopes it.
:::

`credential-bootstrap.md` is the one rule that is not generic advice: it mandates a specific
OpenBao + External Secrets Operator bootstrap pattern for Kubernetes apps, with a named path
convention and ArgoCD sync waves. Its glob keeps it out of the way of every repository that is not
a GitOps tree, which is the only reason a rule that opinionated can ship in a general kit.

## Instructions: always-on global prompts

Six instruction files exist, and they are wired in as global prompts through each client's own
mechanism — a marker-delimited block in `~/.claude/CLAUDE.md`, an `instructions[]` entry in
OpenCode's config, a concatenation into Codex's `developer_instructions`, and `~/.grok/rules/*.md`
for Grok's always-on load. The Codex step declines to touch a `developer_instructions` key it did
not write, warning instead of overwriting.

| Instruction                   | Group               |
| ----------------------------- | ------------------- |
| `anti-glaze.md`               | `core`              |
| `coding-discipline.md`        | `core`              |
| `collaboration-visibility.md` | `core`              |
| `resource-safety.md`          | `core`              |
| `review-discipline.md`        | `review-discipline` |
| `evidence-gated-review.md`    | `strict-review`     |

Five install always. `evidence-gated-review.md` is gated on the `strict-review` group and is removed
when that group is not selected — the marker block is stripped out of `CLAUDE.md`, the OpenCode
config entry is filtered out, and the file itself is deleted.

The Claude blocks are delimited by `<!-- agentkit:<name>:start -->` / `:end` comments, which is what
makes removal surgical rather than a best-effort text match. Legacy blocks appended without markers
are still recognised by their heading.

:::note[Out of scope for the plugin distribution]
Instructions cannot ship in the Claude Code plugin bundle. A plugin cannot inject always-on global
context — only the file installer can place it. If you install via `--claude-plugin`, you get the
hooks and skills and none of this layer.
:::

## Why the split exists

The three layers are ordered by how much context they cost and how reliably they arrive.

An instruction is always in the window, so it must be short and universally applicable. A rule can
afford to be longer and more detailed, because it only arrives when a matching file is in play. A
skill can be long indeed, because most sessions never load it.

That budget is the whole reason the discipline is not one enormous prompt. And it is why the parts
that _must_ hold are not in this layer at all: a rule you paid context for is still a rule the agent
can decide to skip. Only a hook cannot be skipped.
