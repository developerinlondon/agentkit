---
name: huly-work-item-lifecycle
description: >-
  Issue-first workflow and lifecycle hygiene for teams tracking work in Huly:
  every piece of work runs against an issue, statuses stay current on every touch,
  branches and PRs reference the issue, and issues close with a verification note.
  Applies only in repositories configured with agentkit.huly.* git config, so it
  stays inert everywhere else.
  Triggers: starting tracked work in a Huly-backed repo, updating issue status,
  milestone planning, linking a branch or PR to an issue, closing an issue.
---

# Huly Work Item Lifecycle

This skill encodes generic practice only. Org specifics — workspace, project, assignee,
status ids — come from per-repo git config, never from this file.

## Scope gate (check this first, before anything else)

```bash
git config --get agentkit.huly.project
```

**Unset means this repository is not tracked in Huly. Stop — this skill does not apply.**
Say nothing about Huly and fall through to whatever tracker the repo actually uses. A
machine that works across several clients will have Huly config in some repos and a forge
tracker in others; the config decides, never the installed skill.

## Org config

```bash
git config --get agentkit.huly.project     # project identifier, e.g. the PREFIX in PREFIX-1 (also the scope gate)
git config --get agentkit.huly.workspace   # workspace uuid — not the slug in the URL
git config --get agentkit.huly.url         # workspace base url
git config --get agentkit.huly.done-status # status id meaning verified-done
```

If a key is unset the first time it's needed, ask once and offer to persist it with
`git config agentkit.huly.<key> <value>`. Never hardcode an id into a script or doc.

The workspace JWT lives in `HULY_TOKEN`, sourced from the operator's secret store. It must
never be written into the repository, a shell history line, an issue body, or a PR.

## The rules

1. **Issue-first.** Every piece of work runs against an issue. Find an existing one or
   create it BEFORE branching. Trivial fixes inside an existing issue's scope ride that
   issue. Retroactive filing is a fallback, not the default.
2. **Filing has three cases; name which one.** New work unrelated to what is in flight →
   file it. Scope carved out of the issue you are on now → that is a **deferral**, and it
   needs the operator's sign-off before you file it and walk away; the default is to
   finish the scope you accepted. A review finding → the default is to fix it in the PR
   that caused it, and filing has to be justified in the issue itself. Auto-filing every
   finding is what runs a backlog away from its readers.
3. **Reference from the branch and PR — nothing will move the issue for you.** Put the
   `PREFIX-N` identifier in the branch name and the PR description. A self-hosted Huly
   workspace transitions an issue only if the operator wired a forge integration, and that
   is their choice to rely on, not yours. Assume the status is exactly as true as your last
   write to it, and treat every "closes" phrase in a PR as prose. The issue stays open
   through merge and deployment; whoever verifies in the target environment closes it.
4. **Status current on every touch.** Whenever you act on an issue — start it, open a PR,
   merge, park it — move its status in the same breath. A board that lies is worse than
   no board.
5. **Close with a closure note.** State root cause, the fix, and the PR reference, then set
   the done status. Closing without the note loses the trail. `assay.huly` ships no comment
   helper: write the note in the UI, or through a raw transaction against the deployment's
   comment class, whose id `c:model()` will name. A missing helper is not a reason to skip
   the note.
6. **Milestones and components are documents, not labels.** A milestone groups issues by
   when, a component by which part of the system. Both are created once per project and
   then referenced by id from the issue — do not encode either as a title prefix or a
   free-text field.
7. **Sub-issues carry decomposition; the parent stays open.** Break a large issue into
   children rather than a checklist in the description, and close the parent only once
   every child is verified.

## Status map

Statuses are documents, per-deployment and operator-defined. Discover them with
`huly.statuses(c)` rather than assuming names — a stock tracker ships `Backlog`, `Todo`,
`In Progress`, `Done`, `Canceled`, and a customised one ships whatever the space defines.

| When                                     | Typical status |
| ---------------------------------------- | -------------- |
| Filed, awaiting triage                   | `Backlog`      |
| Triaged and accepted, not started        | `Todo`         |
| Actively being worked (human or agent)   | `In Progress`  |
| PR open or merged, awaiting verification | `In Progress`  |
| Verified in the target environment       | `Done`         |
| Rejected or superseded                   | `Canceled`     |

Map these to the deployment's real status ids once and persist the done state in
`agentkit.huly.done-status`.

## Recipes

Prefer the `assay.huly` module over raw HTTP — it centralises auth, the transaction shape,
and the numbering rule below.

```lua
local huly = require("assay.huly")
local c = huly.client({})  -- reads HULY_TOKEN, HULY_WORKSPACE, HULY_URL

local project = huly.resolve_project(c, project_key)

-- Create an issue idempotently: reruns return the existing issue instead of duplicating.
local issue = huly.ensure_issue(c, project, {
  title = "Fix token refresh race",
  description = "…",
  priority = 1,
})

-- Move status
huly.set_issue_status(c, issue, in_progress_status_id)

-- Close after the note is posted, never before
huly.set_issue_status(c, issue, done_status_id)

-- Everything in the project, newest first
local issues = huly.issues(c, project, { limit = 100 })
```

Discover ids from the deployment when the config does not already carry them:

```lua
for _, p in ipairs(huly.projects(c)) do log.info(p.identifier .. " " .. p.name) end
for _, s in ipairs(huly.statuses(c)) do log.info(s._id .. " " .. s.name) end
```

Anything the tracker helpers do not cover is still reachable, because the transactor has
no per-resource endpoints — one class-parameterised query and one transaction document
cover the whole model:

```lua
local overdue = c:find_all("tracker:class:Issue", {
  space = project._id,
  dueDate = { ["$lt"] = os.time() * 1000 },
}, { sort = { dueDate = 1 }, limit = 20 })
```

## Huly gotchas

- **Issue numbering lives on the project, not the issue.** The `PREFIX-N` identifier comes
  from an atomic increment of the project's `sequence`; an issue written without it is
  invisible in the UI. Use `create_issue` / `ensure_issue`. Writing the transaction by hand
  means doing the bump too — and because the bump and the create are two calls, a create
  that fails after the bump burns a number rather than corrupting one.
- **The workspace is a uuid, not the slug in the browser URL.** Every transactor path ends
  in it, so the wrong one fails at the first call with nothing to point at.
- **Idempotency is exact-title.** `ensure_issue` dedupes on the title string. A rerun with
  an edited title files a second issue, so settle the title before the first run.
- **Statuses are ids, not names.** `set_issue_status` writes whatever it is given; a
  human-readable name written into the field yields an issue that renders with no status
  rather than an error.
- **`total` comes back as `-1` unless the request asks for it.** Use `c:count(...)` when a
  number is what you need; reading `total` off a plain find reports nothing.
- **Class-scoped reads omit fields the query pinned.** The module puts `_class` and pinned
  scalars back, so `issue.identifier` reads as expected — code written against raw HTTP
  has to do that itself.
