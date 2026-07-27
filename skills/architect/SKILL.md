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
4. **Produce**:
   - the centerpiece diagram(s) via the **diagram** skill (technical depth:
     real names, real payloads, evidence artifacts),
   - a page via **publish-page** (doc template): overview strip, the diagrams
     in `.figure` blocks with semantic captions, a "decisions & constraints"
     section (why it is shaped this way, what must not be broken), and a
     "sharp edges" section for the traps a newcomer hits,
   - use a stable `--name` (e.g. `<system>-architecture`) so refreshes update
     the SAME URL.
5. **Refresh mode**: when asked to update (or triggered after merges), diff
   what changed since the page's last git version in the pages repo, update
   only the affected zones/sections, republish the same name, and note the
   delta at the top of the page.

## Rules

- Accuracy outranks beauty: a wrong arrow is worse than a missing one. If the
  code contradicts the docs, the code wins and the page says so.
- State your confidence and name what you did NOT verify.
- Never invent architecture direction — document what exists; proposals go in
  a clearly separated "open questions" section, not the diagrams.
