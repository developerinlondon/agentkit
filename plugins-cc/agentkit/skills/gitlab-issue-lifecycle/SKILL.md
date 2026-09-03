---
name: gitlab-issue-lifecycle
description: >-
  Issue-first workflow and lifecycle hygiene for GitLab: every piece of work runs
  against an issue, work-item statuses stay current on every touch, MRs reference
  issues without auto-closing, and issues close with a verification note.
  Complements issue-raiser (which covers researching and writing a new issue).
  Triggers: starting tracked work, updating issue status, linking issues to
  epics, closing issues, referencing issues from MRs.
---

# GitLab Issue Lifecycle

This skill encodes generic practice only. Org specifics — default assignee, epic,
labels, office hours — come from per-repo git config, never from this file.

## Org config (read before creating or updating anything)

```bash
git config --get agentkit.issues.assignee        # default assignee username
git config --get agentkit.issues.epic            # "<group-path>#<epic-iid>", e.g. "my-group/platform#7"
git config --get agentkit.issues.offhours-label  # label to add when working outside office hours
git config --get agentkit.issues.office-hours    # "Area/City HH:MM-HH:MM", e.g. "Europe/London 09:00-17:00"
```

If a key is unset the first time it's needed, ask the user once and offer to persist
the answer with `git config agentkit.issues.<key> <value>`. Detect the GitLab host and
project path from `git remote -v` (see issue-raiser Phase 0) — never hardcode a host.

## The rules

1. **Issue-first, and filing is not free.** Every piece of work runs against an issue.
   Find an existing one (`glab issue list --search`) or create it BEFORE branching.
   Trivial fixes inside an existing issue's scope ride that issue; retroactive filing is
   a fallback, not the default. A finding hit mid-task (a bug, a review comment) defaults
   to being fixed in the change that caused it, not filed — filing every finding is what
   runs a backlog away from its readers, measured on one repository at 34 issues filed in
   three days with 21 still open.

   Every new issue carries a `Disposition:` line in its body naming exactly one of four
   cases; `issue-police` refuses a creation with no line, or one whose value matches none
   of these:
   - `Disposition: in-progress — <scope, who is doing it now>`: new work, unrelated to
     anything in flight, that you are about to build. File it, then branch; the MR closes
     it.
   - `Disposition: owner-deferred — <the owner's own words>`: scope carved OUT of the
     issue you are working on now, deferred with the operator's explicit sign-off quoted.
     The default is still to finish the scope you accepted.
   - `Disposition: owner-request — <the owner's own words>`: the owner asked for this
     issue to be filed.
   - `Disposition: blocked-by <the external system, person, or permission>`: a finding you
     cannot fix in the current change because something outside your control blocks it,
     named.
2. **MRs reference, never auto-close.** Write `Refs #N` in the MR description — never a
   closing keyword. GitLab's default `issue_closing_pattern` auto-closes on merge for the
   **close / fix / resolve / implement** families and all their inflections:
   `close(s/d/ing)`, `fix(es/ed/ing)`, `resolve(s/d/ing)`, `implement(s/ed/ing)`. `Implements #N`
   and `Fixes #N` close the issue exactly like `Closes #N` does — and one closing keyword
   anywhere in the description wins even if `Refs #N` also appears. The auto-close is baked
   into the **merge/squash commit message** (via the `%{issues}` template variable), so it
   fires even when the poller merges via API, not just on UI merge. The issue must stay open
   through merge and deployment; whoever verifies the fix in the target environment closes it.
   Audit the whole MR body (and any commit subject that lands on the default branch) for these
   keywords before opening — "Implements" as an opening verb is the easy one to miss.
3. **Status current on every touch.** Whenever you act on an issue (start work, open an
   MR, merge, park it), update its work-item status in the same breath — a board that
   lies is worse than no board. See the status map below.
4. **Close with a closure note.** When verified, post a note stating root cause, the
   fix, and the MR reference — then close. Closing without the note loses the trail.
5. **Epic link on creation.** If `agentkit.issues.epic` is set, attach every new issue
   to that epic (recipe below).
6. **Off-hours label.** If `agentkit.issues.office-hours` is set and the wall clock in
   that zone is outside the window, add `agentkit.issues.offhours-label` at creation.

## Status map (work-item statuses)

Statuses are grouped by category; discover the actual names per namespace (query
below) — never hardcode status IDs across instances.

| When                                            | Category                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Filed, awaiting human triage decision           | `triage`                                                             |
| Triaged, accepted, parked (e.g. pending design) | `to_do`                                                              |
| Anyone (human or bot) actively working it       | `in_progress`                                                        |
| MR up or merged, awaiting verification          | `in_progress` (an "In review"-named status if the lifecycle has one) |
| Verified and closed                             | `done` (auto-set when the issue is closed)                           |
| Rejected / superseded                           | `canceled`                                                           |

## Recipes

Work-item status is **GraphQL-only** — it is a widget, separate from the REST
open/closed state.

```bash
# Discover the lifecycle statuses for the namespace (IDs differ per instance):
glab api graphql -f query='query { namespace(fullPath: "<group>") {
  lifecycles { nodes { name statuses { id name category } } } } }'

# Read current status + global work-item id for issues by iid:
glab api graphql -f query='query { project(fullPath: "<group/project>") {
  workItems(iids: ["12"]) { nodes { iid state id
    widgets { ... on WorkItemWidgetStatus { status { id name } } } } } } }'

# Set a status:
glab api graphql -f query='mutation { workItemUpdate(input: {
  id: "gid://gitlab/WorkItem/<global-id>",
  statusWidget: {status: "gid://gitlab/WorkItems::Statuses::Custom::Status/<n>"}
}) { errors } }'
```

```bash
# Link an issue to an epic — needs the issue's GLOBAL id (the `id` field),
# NOT the project-scoped iid:
glab api -X POST "groups/<url-encoded-group>/epics/<epic-iid>/issues/<issue-global-id>"
```

```bash
# Close with a closure note (note first, then close):
glab api -X POST "projects/<url-encoded-path>/issues/<iid>/notes" \
  -H "Content-Type: application/json" --input note.json
glab api -X PUT "projects/<url-encoded-path>/issues/<iid>" -f state_event=close
```

## glab gotchas (cost real debugging time — respect them)

- **Form-encoded arrays silently drop.** `-F "user_ids[]=5"` and `-F "assignee_ids[]=5"`
  do not reach the server as arrays. Always send arrays/objects as a JSON body:
  `-H "Content-Type: application/json" --input payload.json`.
- **zsh does not word-split unquoted variables.** A `for pair in "a b" ...; set -- $pair`
  loop that works in bash builds broken URLs in zsh. Prefer explicit commands or
  python for anything beyond a trivial loop.
- The project's approvals/notes/issues REST endpoints accept a JSON body with the same
  field names the docs list as form params — when a form call 400s/404s mysteriously,
  retry as JSON before assuming the endpoint is wrong.
