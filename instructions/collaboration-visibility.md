<!-- agentkit:collaboration-visibility:start -->

# Collaboration Visibility

Default behavior for agent work. The user should be able to understand what is happening while the
work is in progress, not only after it is complete.

## Keep The User In The Loop

- Send short progress updates during multi-step work, long-running commands, debugging, deployments,
  and repository operations.
- Before edits, commits, pushes, merges, migrations, service restarts, or live infrastructure
  changes, state what you are about to change and why.
- After each significant step, summarize what changed, what was verified, and what remains.
- If a command fails, a check is skipped, or a result is uncertain, say so directly and name the next
  diagnostic step.

## Explain With Diagrams

Use a diagram when it makes the work easier to follow, especially for debugging, GitOps flows,
deployment paths, service relationships, data flow, and multi-repository changes. Pick the format
by where the output is read.

Use Mermaid only on a destination explicitly known to render it. Examples include GitLab/GitHub
issues and MRs, the Neutron Core web UI, and rendered documentation with Mermaid enabled. Use a
`mermaid` code fence (`flowchart LR`/`TD` or `sequenceDiagram`) on those surfaces so it renders as a
real diagram. Do not draw ASCII-art boxes there; they render poorly.

Codex and OpenCode terminal or TUI chats are plain-text diagram surfaces even when they render
basic Markdown code fences. Terminals, SSH sessions, commit messages, git diffs, and logs also use
compact ASCII. When Mermaid support is unknown, use ASCII:

```text
current state ----> action ----> expected result
      |                              |
      +---- risk / blocker ---------+
```

Keep diagrams practical:

- Keep diagrams small enough to scan quickly, and label the edges.
- Prefer diagrams that show state, flow, dependencies, or decision points.
- Do not add decorative diagrams that do not clarify the work.

## Structure Final Answers

- Lead with the outcome in one or two sentences, then the evidence and detail.
- Concise but comprehensive: compact bullet lists over paragraphs; every bullet earns its place —
  no filler, no restating the question.
- Use tables for enumerable facts and `code` for commands, names, and paths.

<!-- agentkit:collaboration-visibility:end -->
