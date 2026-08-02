---
name: github-issue-lifecycle
description: >-
  Issue-first workflow and lifecycle hygiene for GitHub: every piece of work runs
  against an issue, Projects v2 status stays current on every touch, PRs reference
  issues without triggering auto-close, and issues close with a verification note.
  GitHub counterpart of gitlab-issue-lifecycle. Triggers: starting tracked work,
  updating issue/project status, closing issues, referencing issues from PRs.
---

# GitHub Issue Lifecycle

This skill encodes generic practice only. Org specifics — default assignee, project
board, labels, office hours — come from per-repo git config, never from this file.

## Org config (read before creating or updating anything)

```bash
git config --get agentkit.issues.assignee        # default assignee login (or "@me")
git config --get agentkit.issues.project         # Projects v2 number or URL, e.g. "7"
git config --get agentkit.issues.offhours-label  # label to add when working outside office hours
git config --get agentkit.issues.office-hours    # "Area/City HH:MM-HH:MM", e.g. "Europe/London 09:00-17:00"
```

If a key is unset the first time it's needed, ask the user once and offer to persist
the answer with `git config agentkit.issues.<key> <value>`.

## The rules

1. **Issue-first, and filing is not free.** Every piece of work runs against an issue.
   Find an existing one (`gh issue list --search`) or create it BEFORE branching. Trivial
   fixes inside an existing issue's scope ride that issue. Three things look identical at
   the moment you type `issue create`, and only the first is unambiguously right:
   - **New work**, unrelated to anything in flight → file it, then branch.
   - **Scope carved OUT of the issue you are working on now** → a **deferral**, not a
     discovery. It needs the operator's explicit sign-off before you file it and walk
     away; the default is to finish the scope you accepted.
   - **A review finding** → the default disposition is _fix it in the PR that caused it_.
     Filing is the exception and has to be justified in the issue itself: out of that
     PR's scope, blocked on a decision, or blocked on other work. Auto-filing every
     finding is what runs a backlog away from its readers — measured on one repository,
     34 issues filed in three days with 21 still open.

   Whichever it is, say so. Every new issue carries a `Disposition:` line in its body
   naming the case; the `issue-police` hook refuses a creation without one.
2. **PRs reference, never auto-close.** Write `Refs #N` in the PR body — never
   `Closes/Fixes/Resolves #N`. GitHub's closing keywords auto-close the issue the
   moment the PR merges to the default branch; the issue must stay open until the fix
   is verified in the target environment.
3. **Status current on every touch.** Whenever you act on an issue (start work, open a
   PR, merge, park it), update its Projects v2 Status field in the same breath. No
   project board configured → use labels or assignment as the signal, but stay
   consistent.
4. **Close with a closure note.** When verified, close with a comment stating root
   cause, the fix, and the PR reference: `gh issue close N --comment "..."`. Use
   `--reason completed` for fixed, `--reason "not planned"` for rejected/superseded.
5. **Project link on creation.** If `agentkit.issues.project` is set, add every new
   issue to that project (recipe below).
6. **Off-hours label.** If `agentkit.issues.office-hours` is set and the wall clock in
   that zone is outside the window, add `agentkit.issues.offhours-label` at creation.

## Status map (Projects v2 Status field)

Field options vary per project — discover them (query below), match by intent:

| When                                      | Typical option   |
| ----------------------------------------- | ---------------- |
| Filed, awaiting triage decision           | Triage / Backlog |
| Triaged, accepted, parked                 | Todo             |
| Anyone (human or bot) actively working it | In Progress      |
| PR up or merged, awaiting verification    | In Review        |
| Verified and closed                       | Done             |

## Recipes

```bash
# Create with the org conventions applied:
gh issue create --title "..." --body "..." \
  --assignee "$(git config --get agentkit.issues.assignee)" \
  --label "<labels>"

# Add an issue to the configured Projects v2 board (needs the org/user owner):
gh project item-add <project-number> --owner <owner> --url <issue-url>

# Discover the Status field id and its options:
gh project field-list <project-number> --owner <owner> --format json

# Find the item id for the issue, then set Status:
gh project item-list <project-number> --owner <owner> --format json  # → item id
gh project item-edit --project-id <project-id> --id <item-id> \
  --field-id <status-field-id> --single-select-option-id <option-id>
```

```bash
# Close with a closure note after verification:
gh issue close <n> --reason completed --comment "Root cause: ... Fixed by #<pr>: ...
Verified: <how>."
```

## Gotchas

- **Closing keywords hide in PR bodies and commit messages.** `Fixes #N` anywhere in a
  PR body (or a commit that lands on the default branch) auto-closes — audit generated
  text for them when the review-driven lifecycle is in force.
- **Projects v2 is a separate API surface.** Issue state (`open`/`closed`,
  `state_reason`) lives on the issue; Status lives on the project item. Closing an
  issue does NOT move its project Status unless the project has an auto-archive /
  workflow rule — check, and set Status explicitly when in doubt.
- `gh project` commands need the `project` scope: if they 401/403,
  run `gh auth refresh -s project`.
