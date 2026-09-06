---
name: workspace-diagrams
description: >-
  Where a team's diagrams live and how they stay current when the boards are held in an
  ExcaliDash dashboard: one board per subject in a named collection, referenced by URL
  from the tracker rather than copied into it, exported as a snapshot for surfaces that
  cannot reach the dashboard, and drawn only when a picture carries what prose cannot.
  Applies only in repositories configured with agentkit.excalidash.* git config, so it
  stays inert everywhere else.
  Triggers: drawing or updating an architecture board, attaching a diagram to an issue or
  document, exporting a diagram into a PR or README, auditing whether a board is stale.
---

# Workspace Diagrams

This skill encodes generic practice only. Org specifics — dashboard origin, collection
names, credentials — come from per-repo git config and the environment, never from this
file.

## Scope gate (check this first, before anything else)

```bash
git config --get agentkit.excalidash.collection
```

**Unset means this repository's diagrams do not live in a dashboard. Stop — this skill
does not apply.** Say nothing about ExcaliDash and fall through to the repo's own habit:
a mermaid fence in the markdown, an SVG committed beside the doc, ASCII in the terminal.

## Org config

```bash
git config --get agentkit.excalidash.collection # collection holding this repo's boards (also the scope gate)
git config --get agentkit.excalidash.url        # dashboard origin
git config --get agentkit.excalidash.export-dir # repo path where exported snapshots land
```

If a key is unset the first time it's needed, ask once and offer to persist it with
`git config agentkit.excalidash.<key> <value>`.

Credentials come from the environment — `EXCALIDASH_API_KEY` for automation,
`EXCALIDASH_TOKEN` for the routes an API key cannot reach. Neither belongs in the
repository, a shell history line, or a drawing name.

## When to draw at all

A diagram earns its place when it shows **state, flow, dependency, or a decision point** —
something the reader would otherwise have to hold in their head while reading prose. Five
identical boxes with different names have said nothing; delete them.

Pick the cheapest surface that renders:

| Surface                                                  | Use                                        |
| -------------------------------------------------------- | ------------------------------------------ |
| Terminal, commit message, diff, log                      | ASCII — nothing else renders there         |
| Markdown on a forge or docs site with mermaid            | a `mermaid` fence, versioned with the text |
| A figure that outgrows both, or that several people edit | a board in the dashboard                   |

A board is the expensive option: it lives outside the repository, so it has to be
maintained deliberately. Reach for it when the figure is long-lived and shared, not for a
one-off explanation inside a single PR.

## The rules

1. **One board per subject, in the repo's collection.** Name it after the subject, not
   after the task that produced it — `Ingress path`, not `Ingress path (redesign)`. A
   board named after an event goes stale the moment the event is over.
2. **The board is the original; everything else references it.** An issue or a document
   links to the board by URL. Never paste a second editable copy into the tracker — two
   editable copies means the reader cannot tell which one is true.
3. **Export and attach, do not duplicate.** For a surface that cannot reach the dashboard
   — a PR description, a README, a page for someone without an account — export a
   rendered snapshot and attach it, with the board URL beside it as the source. The
   snapshot is derived: when the picture changes, redraw on the board and re-export.
   Never edit an exported file and call it current.
4. **Update in the same breath as the thing it describes.** A board that describes a
   system is part of that system's change. If a PR changes the flow, the board moves in
   that PR's cycle or it is wrong from merge onward.
5. **Guard every scene write with the version you read.** Passing `version` makes the
   write conditional, so a board someone else moved is refused rather than clobbered. An
   unguarded write is a silent overwrite of whoever drew last.
6. **Version history is a two-day window, not an archive.** Snapshots are swept hourly, so
   history recovers a mistake made in the last hour or two and nothing older. Anything that must survive
   belongs in the repository as an exported file or in the issue that recorded the
   decision.
7. **Authoring goes through the `diagram` skill.** It produces Excalidraw JSON — exactly
   the `elements` and `app_state` a board takes — so the same scene renders to a
   self-contained SVG for the repo and uploads to the dashboard for the team, with no
   second act of drawing.

## Credential reach

The credential decides how much of the API is reachable, and the failure is silent-ish:
the routes an API key cannot reach answer 403 or a bare 401 without saying why.

| Capability                                   | API key | Session token |
| -------------------------------------------- | ------- | ------------- |
| List, read, create, update, delete drawings  | yes     | yes           |
| List, create, rename, delete collections     | yes     | yes           |
| Version history: list, read, restore         | no      | yes           |
| Sharing: permissions, link shares, duplicate | no      | yes           |

Plan automation around the top half. A scheduled job holding only an API key can keep
boards current but cannot restore one or share it — if the job needs either, it needs a
session token, and that is a decision to make deliberately rather than discover at 3am.

## Recipes

```lua
local excalidash = require("assay.excalidash")
local c = excalidash.client({})  -- reads EXCALIDASH_API_KEY / EXCALIDASH_TOKEN / EXCALIDASH_URL

local folder = excalidash.ensure_collection(c, collection_name)

-- Idempotent: reruns update the existing board instead of filing a second one.
local board = excalidash.ensure_drawing(c, {
  name = "Ingress path",
  collection_id = folder.id,
  elements = scene.elements,
  app_state = scene.appState,
})

-- Guarded update: re-read, then write against the version you read.
local current = c.drawings:get(board.id)
c.drawings:update(board.id, { elements = edited, version = current.version })
```

A `VERSION_CONFLICT` means someone drew while you were editing. Re-read, merge, write
again — never retry without the fresh version, which just wins the race by force.

Retiring a board is a move, not a delete:

```lua
excalidash.trash(c, board.id)          -- reversible
excalidash.undo_last_change(c, board.id) -- restores the newest snapshot (session token)
```

## ExcaliDash gotchas

- **A wrong API path reads as an empty dashboard, not as an error.** The dashboard answers
  any unknown path with the SPA's HTML and a 200. The module refuses a non-JSON body and
  names the setting to check; code written against raw HTTP will happily report zero
  drawings.
- **`search` is a substring filter, not a lookup.** It narrows a scan; it cannot stand in
  for an exact-name comparison, so a board named `Ingress` and one named `Ingress path`
  both come back.
- **Listing omits the scene unless asked.** Summaries carry no elements without
  `include_data`, which is what keeps listing a large dashboard cheap — and what makes a
  naive "export everything" loop silently write empty files.
- **Deleting a collection does not delete its drawings.** They are moved out to no
  collection at all, which is how boards go missing from a tab while still existing.
- **One link share is active per drawing.** Creating another revokes the one before it, so
  re-sharing a board breaks the link already circulating.
