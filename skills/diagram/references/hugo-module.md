# Figures for Hugo docs sites

A Hugo site does not render a diagram from a tool's output; its build does, from data.
The module lives at `hugo/diagrams/` in the agentkit repository and is imported as
`github.com/developerinlondon/agentkit/hugo/diagrams`. Its README is the full reference:
the import recipe, every spec field, site settings, icons and what the build checks. This
page is the working method.

## Before the first spec

1. Confirm the site imports the module before its theme and calls
   `partial "diagram/head.html"` in `<head>`. If it does not, follow the README's five
   steps first; a spec without the module renders nothing.
2. Classify as usual (`references/selection.md`). The spec language draws flows (boxes,
   groups, labelled orthogonal edges, notes) and sequences (actors, messages, notes,
   alt/else). A type it cannot express — an ERD with cardinality, a timeline — is a D2 or
   sketch figure embedded as an image instead.

## Writing a spec

```yaml
title: Checkout # becomes <title>
description: >- # becomes <desc> and opens the text version
  A browser calls the API, which writes to Postgres and queues slow work.
caption: The API stays stateless.
grid: { col: 160, row: 90 } # px per grid unit
nodes:
  - { id: api, label: API, sublabel: stateless, kind: accent, col: 1, row: 1 }
  - { id: db, label: Postgres, icon: logos/postgresql, kind: fill, col: 2.4, row: 1 }
edges:
  - { from: api, to: db, style: data, label: writes }
```

- Positions are the node's centre in grid units. Lay the figure out by hand on the grid;
  stable coordinates are the point, and the build never moves anything.
- One accent (`kind: accent`, `style: data`) for the system and its data path; amber
  (`gate`) for anything waiting on a person; red and green only for refused and allowed.
- Labels are the real names: routes, events, tables. The same rule as the technical depth
  in SKILL.md step 1.
- Quote any list item that contains a comma: `sublabel: ["a, b", c]` is two lines, while
  `[a, b, c]` is three.
- `icon:` names come from the module's packs. Look a brand up with
  `bun <skill-dir>/scripts/find-icon.ts <name>`; write `logos/<name>` for full-colour art and
  `simple-icons/<name>` for a single-colour mark. A project's own pack is `@<pack>/<name>`.

## Checking it

Run the site's copy of `scripts/check-diagrams.sh`. It fails on every build error and on
the two layout warnings: a node too narrow for its text, and an edge label longer than its
segment. Fix a warning by moving nodes apart or pinning the label with `label_at`.

The readability floor fails a canvas too wide for the column: its 11 px labels would show
below `min_inline_px` (8 by default) at `content_width` (625). Narrow the grid, stack the
figure top to bottom, or split it in two. Readers who want the labels at full size use the
Enlarge control, which shows the canvas at 1:1.

Then LOOK, as in step 5: screenshot the built page in light and dark, at desktop and phone
width, scrolled to the figure. The build cannot see two labels overlapping.
