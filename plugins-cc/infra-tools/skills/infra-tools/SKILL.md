---
name: infra-tools
description: >-
  Inspect Helm releases and charts, preview OpenTofu/Terraform plans, and read
  git history using the read-only infra-tools MCP server. Trigger when asked to
  render/template a Helm chart, list releases or get their values, run a tofu/
  terraform plan or show/state-list, or read git log/diff/status or clone a repo
  for inspection. All operations are read-only — never applies or mutates.
---

# infra-tools

Read-oriented wrappers around the infrastructure CLIs that stay raw engines
(`helm`, `tofu`/`terraform`, `git`). Each is a typed MCP tool, so a host gates by
**tool name + structured arguments** instead of regex-parsing a shell string.

## Golden rule

These tools **only read**. There is no tool that applies, upgrades, destroys,
pushes, or commits. If a task needs to change infrastructure, produce the plan or
diff with these tools and hand it to review — the change itself goes through the
normal write path (e.g. a GitLab MR / approval-gated flow), never through here.

## Tools

| Tool              | Runs                         | What it does                                           |
| ----------------- | ---------------------------- | ------------------------------------------------------ |
| `helm_template`   | `helm template`              | Render a chart locally (no install, no cluster write). |
| `helm_list`       | `helm list`                  | List installed releases.                               |
| `helm_get_values` | `helm get values`            | Read a release's user-supplied values.                 |
| `tofu_plan`       | `tofu plan` (or `terraform`) | Preview a change set — never applies.                  |
| `tofu_show`       | `tofu show`                  | Show current state or a saved plan.                    |
| `tofu_state_list` | `tofu state list`            | List resources tracked in state.                       |
| `git_log`         | `git log`                    | Read commit history of a local repo.                   |
| `git_diff`        | `git diff`                   | Read changes in a local repo.                          |
| `git_status`      | `git status`                 | Read working-tree status.                              |
| `git_clone_ro`    | `git clone --depth 1`        | Shallow read-only clone into `dest` for inspection.    |

`git_clone_ro` is the only tool that writes to disk — it clones a remote **for
reading**, shallow and tag-free, and never pushes or mutates the source.

## Requirements

- `bun` on PATH (the server runs directly as a `.ts` file — no build step).
- The relevant CLI on PATH for the tool you call (`helm`, `tofu`/`terraform`,
  `git`). `tofu_*` tools fall back to `terraform` when `tofu` is absent.

Each tool returns `{ ok, stdout, stderr, exit_code }` as JSON text content.
