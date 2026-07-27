---
name: architect
description: Study a system and produce living architecture documentation — explanatory pages with high-quality diagrams. Use AUTOMATICALLY when the user asks to document, explain, map, or review an architecture ("how does this system work", "architecture diagram of this repo", "create/refresh the design docs"), or to keep architecture pages current after changes. Orchestrates the diagram and publish-page skills.
---

# architect

You are producing the document a strong staff engineer would write after
genuinely understanding a system — not a file listing with boxes around it.

## Workflow

1. **Scope**: name the system(s) and the audience question the page must
   answer ("how does a request flow", "what owns what", "where does state
   live"). One page per question; link pages rather than bloating one.
2. **Study before drawing.** Read entry points, deploy/infra configs, service
   boundaries, schemas, and the seams between components. Verify claims in
   code — including absences ("nothing else writes this table" needs grepping,
   not assuming). For third-party pieces, check the real docs; never draw from
   memory.
3. **Find the load-bearing structure**: the 3–7 components whose removal would
   change the story, the flows between them, the state stores, and the
   trust/ownership boundaries. Everything else is detail inside a zone.
4. **Figure plan before authoring**: emit a table of concept → concept type →
   treatment → why-not-a-table, one row per intended visual, derived from the
   publish-page routing table. Name exactly ONE centerpiece and 2–5 supporting
   figures, and account for every h2 section — a section with no figure is a
   stated choice, not an omission. Never route a flow containing a repair
   loop, approval gate, or failure branch to the box kits: the load-bearing
   part is the backward edge, which only a drawn figure can show. Present the
   plan in the same message as the publish-approval request so one gate covers
   both.
5. **Produce**:
   - the centerpiece diagram(s) via the **diagram** skill (technical depth:
     real names, real payloads, evidence artifacts; respect its canvas and
     density budgets — a diagram covering several separate headings is several
     figures),
   - a page via **publish-page** (doc template): overview strip, the diagrams
     in `.figure` blocks with semantic captions, a "decisions & constraints"
     section (why it is shaped this way, what must not be broken), and a
     "sharp edges" section for the traps a newcomer hits,
   - use a stable `--name` (e.g. `<system>-architecture`) so refreshes update
     the SAME URL.
6. **Refresh mode**: when asked to update (or triggered after merges), diff
   what changed since the page's last git version in the pages repo, re-run
   the figure plan against the diff (changed zones get re-authored figures; a
   figure whose caption is no longer true is a blocker, not cosmetic lag),
   update only the affected zones/sections, republish the same name, and note
   the delta at the top of the page.

## The bar: impress a staff engineer

An experienced architect looking at your centerpiece diagram should learn
something and find nothing to correct. That means the diagram shows what
seniors actually look for, not just boxes and arrows:

- **Boundaries drawn as boundaries** — trust, ownership, network, and process
  boundaries as visible zones, not implied by proximity.
- **Edges that say something**: protocol + direction + what actually travels
  (`PUT /api/pages/:slug · HTML ≤5MB`, not "sends data"). Sync vs async
  distinguishable at a glance (solid vs dashed).
- **State made explicit** — every store shown with what owns it and what only
  reads it.
- **The failure story** — what breaks when each critical edge dies, marked on
  the diagram (error-role color), not left to the appendix.
- **Numbers where they exist** — caps, timeouts, quotas, cardinalities pulled
  from config/code, never invented.
- **The why on the page** — one decisions-and-constraints section that names
  the forces that shaped the design; a diagram that only shows "what" is half
  a diagram.

## Rules

- Accuracy outranks beauty: a wrong arrow is worse than a missing one. If the
  code contradicts the docs, the code wins and the page says so.
- State your confidence and name what you did NOT verify.
- Never invent architecture direction — document what exists; proposals go in
  a clearly separated "open questions" section, not the diagrams.
- **Publishing internal systems requires the user's explicit go-ahead**: pages
  are public-by-slug until the accounts phase, and architecture pages are by
  nature internal material — confirm before the first publish of a system's
  page (refreshes of an already-approved page are fine).
