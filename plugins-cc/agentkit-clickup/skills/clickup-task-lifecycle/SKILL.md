---
name: clickup-task-lifecycle
description: >-
  Task-first workflow and lifecycle hygiene for teams tracking work in ClickUp:
  every piece of work runs against a task, statuses stay current on every touch,
  branches and PRs reference the task without relying on auto-close, and tasks
  close with a verification note. Applies only in repositories configured with
  agentkit.clickup.* git config, so it stays inert everywhere else.
  Triggers: starting tracked work in a ClickUp-backed repo, updating task status,
  sprint planning, linking a branch or PR to a task, closing a task.
---

# ClickUp Task Lifecycle

This skill encodes generic practice only. Org specifics — workspace, list, assignee,
status names — come from per-repo git config, never from this file.

## Scope gate (check this first, before anything else)

```bash
git config --get agentkit.clickup.list
```

**Unset means this repository is not tracked in ClickUp. Stop — this skill does not
apply.** Say nothing about ClickUp and fall through to whatever tracker the repo
actually uses. A machine that works across several clients will have ClickUp config in
some repos and a forge tracker in others; the config decides, never the installed skill.

## Org config

```bash
git config --get agentkit.clickup.list        # default list id for new tasks (also the scope gate)
git config --get agentkit.clickup.workspace   # workspace id (the v2 API calls it team_id)
git config --get agentkit.clickup.assignee    # default assignee user id
git config --get agentkit.clickup.done-status # status name meaning verified-done, e.g. "closed"
```

If a key is unset the first time it's needed, ask once and offer to persist it with
`git config agentkit.clickup.<key> <value>`. Never hardcode an id into a script or doc.

The API token lives in `CLICKUP_TOKEN`, sourced from the operator's secret store. It must
never be written into the repository, a shell history line, a task body, or a PR.

## The rules

1. **Task-first.** Every piece of work runs against a task. Find an existing one or
   create it BEFORE branching. Trivial fixes inside an existing task's scope ride that
   task. Retroactive filing is a fallback, not the default.
2. **Filing has three cases; name which one.** New work unrelated to what is in flight →
   file it. Scope carved out of the task you are on now → that is a **deferral**, and it
   needs the operator's sign-off before you file it and walk away; the default is to
   finish the scope you accepted. A review finding → the default is to fix it in the PR
   that caused it, and filing has to be justified in the task itself. Auto-filing every
   finding is what runs a backlog away from its readers.
3. **Reference from the branch and PR; never rely on auto-close.** Put the task id in the
   branch name and the PR description. ClickUp's GitHub/GitLab integration can be
   configured to transition or close a task on merge — treat that as the operator's
   choice, not yours. The task stays open through merge and deployment; whoever verifies
   in the target environment closes it.
4. **Status current on every touch.** Whenever you act on a task — start it, open a PR,
   merge, park it — move its status in the same breath. A board that lies is worse than
   no board.
5. **Close with a closure note.** Post a comment stating root cause, the fix, and the PR
   reference, then set the done status. Closing without the note loses the trail.
6. **Sprint membership is a list move, not a label.** ClickUp models a sprint as a List
   inside a Sprint Folder. Moving a task between sprints means moving it between lists —
   do not invent a "sprint" custom field when the workspace already has Sprint Folders.
7. **KPIs are custom fields or Goals, never free text.** A number that matters goes in a
   custom field (queryable, roll-uppable) or a Goal target. Numbers buried in a
   description cannot be reported on.

## Status map

Status names are per-space and operator-defined. Discover them from the list rather than
assuming — `c.lists:get(list_id).statuses` returns the space's actual set.

| When                                    | Typical status  |
| --------------------------------------- | --------------- |
| Filed, awaiting triage                  | `to do`         |
| Triaged and accepted, not started       | `to do`         |
| Actively being worked (human or agent)  | `in progress`   |
| PR open or merged, awaiting verification| `in review`     |
| Verified in the target environment      | `complete`      |
| Rejected or superseded                  | `closed`        |

Map these to the workspace's real names once and persist the done state in
`agentkit.clickup.done-status`.

## Recipes

Prefer the `assay.clickup` module over raw curl — it centralises auth, pagination, and
error handling, and it is not subject to the MCP call cap described below.

```lua
local clickup = require("assay.clickup")
local c = clickup.client()  -- reads CLICKUP_TOKEN

-- Create a task idempotently: reruns return the existing task instead of duplicating.
local task = clickup.ensure_task(c, list_id, {
  name = "Fix token refresh race",
  description = "…",
  assignees = { assignee_id },
})

-- Move status
c.tasks:update(task.id, { status = "in progress" })

-- Close with a note, in that order
c.comments:create(task.id, "Root cause: … Fix: … PR: …")
c.tasks:update(task.id, { status = done_status })

-- Every task in a sprint list, following pagination to the end
local all = clickup.all_tasks(c, list_id)

-- Record a KPI on a custom field
c.fields:set(task.id, field_id, 42)
```

Discover ids top-down when the config does not already carry them:

```lua
local team = clickup.resolve_team(c)              -- errors if the token sees several
local spaces = c.spaces:list(team.id)
local folders = c.folders:list(spaces[1].id)      -- Sprint Folders live here
local lists = c.lists:list(folders[1].id)         -- each sprint is a List
```

## ClickUp API gotchas

- **The token goes in `Authorization` raw — no `Bearer` prefix.** Personal `pk_` tokens
  are rejected when prefixed, which is the opposite of nearly every other API.
- **Pagination is zero-based `page`, capped at 100 tasks, and the envelope flags the end
  with `last_page`.** There is no cursor. A loop that stops on an empty page instead of
  on `last_page` will truncate silently when a page is exactly full.
- **List-valued filters repeat as `statuses[]=`,** not comma-joined.
- **Goals use singular paths.** `/team/{id}/goal` to list, `/goal/{id}` for one — and the
  single-goal path is not nested under the team.
- **Docs are the one resource on API v3,** rooted at `/v3/workspaces/{id}/docs`.
  Everything else is v2, where "team" means what the UI calls a Workspace.
- **The official MCP server is capped at 50 calls per 24h on the Free plan** and 300 on
  paid tiers, while the REST API allows 100 requests per minute on the same plan. Drive
  automation through the REST API; the MCP endpoint cannot carry a working agent loop.
