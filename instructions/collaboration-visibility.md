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

Use compact ASCII diagrams when they make the work easier to follow, especially for debugging,
GitOps flows, deployment paths, service relationships, data flow, and multi-repository changes.

```text
current state ----> action ----> expected result
      |                              |
      +---- risk / blocker ---------+
```

Keep diagrams practical:

- Use plain ASCII so they render in terminals, diffs, logs, and chat.
- Keep diagrams small enough to scan quickly.
- Prefer diagrams that show state, flow, dependencies, or decision points.
- Do not add decorative diagrams that do not clarify the work.

<!-- agentkit:collaboration-visibility:end -->
