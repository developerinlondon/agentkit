---
name: designer
description: Design and build bespoke, self-contained HTML pages at artifact grade — design docs, product design briefs (PDs), proposals, reports with UI mockups. Use AUTOMATICALLY whenever a page's visual quality is part of the deliverable ("make it polished", "design doc as a page", "like a Claude artifact"), whenever authoring a design/proposal page in a product repo, and whenever a document needs a product-surface mockup, flow strip, or phase cards. Produces the HTML; publish-page or a product repo hosts it.
---

# designer

You are the design lead for this page. The output is a **bespoke, self-contained
HTML page** whose visual system was designed for its subject — never a generic
theme with content poured in. This skill owns how the page looks; what it says
comes from the caller (often the architect skill), and where it lives is the
host's business (publish-page `--template raw`, a product repo's `public/`, an
artifact).

The bar: put the page next to one produced by Claude artifacts for the same
content and a reviewer cannot tell which needed a designer.

## Workflow

1. **Read the request.** A design doc, plan, or brief gets the polished
   utilitarian treatment this skill encodes: real hierarchy, considered
   spacing, a proper palette, no gigantic hero. Only a landing page or
   keep-and-share app earns editorial flourish. When unsure, well-composed
   beats over-designed.
2. **Write the design plan before any code** — three lines, kept with the work:
   - **Color**: 4–6 named hex values — neutrals with a slight hue bias toward
     the accent, plus 2–4 **semantic families taken from the subject's own
     distinctions** (exists/build/gated/ok, pass/warn/fail, now/next/later…),
     each with a `-soft` background variant. Semantic color answers "what does
     the reader need to tell apart", never decoration.
   - **Type**: a sans for body, mono for labels/data only. Name the stacks.
   - **Layout**: one sentence, e.g. "wide canvas for figures, narrow measure
     for prose, sections separated by air not rules".
3. **Start from `references/scaffold.html`.** Copy it, rename the semantic
   token families to the plan's, re-derive every value, and delete every
   component the page does not use. The scaffold is a floor for quality, not a
   ceiling for invention — but its token structure (3-level surface stack,
   `-soft` variants, three theme blocks) is the contract.
4. **Compose sections** by routing each concept through the component grammar
   below. Real content everywhere: real paths, real payloads, real numbers —
   a mockup with placeholder labels is a failure exactly like a diagram with
   "API" boxes.
5. **Verify by looking** (mandatory): open the file in a browser session at
   ~1280 px, screenshot **both themes** (stamp `data-theme` on `<html>` to
   flip), Read the screenshots, fix, repeat until nothing clips, contrast
   holds, and both themes look designed rather than inverted. Never deliver an
   unviewed page. Two rules that make the look honest:
   - **Screenshot the full height.** Read `documentElement.scrollHeight` from
     the rendered page first and size the capture window to it — a fixed-height
     window verifies the top of the page and silently calls the rest clean.
   - **Measure, don't estimate.** Absolute-positioned figures (mockup edges,
     sequence messages) depend on how text wraps in the font that actually
     resolves. Dump the rendered nodes' `offsetLeft/Top/Width/Height` with a
     DOM probe and derive SVG endpoints from the measured borders; in the same
     probe assert `scrollWidth === clientWidth` on every `overflow-x` wrapper —
     a horizontally clipped figure is invisible under `--hide-scrollbars`.
   - **Compute contrast, don't eyeball it.** In the same probe, resolve the
     tokens per theme and compute the WCAG ratio of every semantic text/ground
     pair actually used (`--x` on `--surface`, `--x` on `--x-soft`, button text
     on `--x`); each must clear 4.5:1. The eye happily passes a 3.2:1 mono
     pill that the contract fails.

## The token contract

- Neutrals: `--bg`, `--surface`, `--surface-2`, `--ink`, `--muted`, `--line`,
  `--line-soft`. Three surface levels minimum — depth comes from surface
  layering, not shadows.
- Every semantic family is a pair: `--x` (border/text, ≥4.5:1 on `--surface`
  AND on its own `--x-soft`) and `--x-soft` (its background ground). The
  soft-ground requirement is the binding one — light-theme accents that look
  right usually land near 3:1 there and must be darkened.
- Three theme blocks, token-level only: base `:root`, then
  `@media (prefers-color-scheme: dark)`, then BOTH `:root[data-theme="dark"]`
  and `:root[data-theme="light"]` so a host's toggle overrides the OS in both
  directions. Components never restyle inside the color-scheme media query —
  theme changes travel through tokens only; layout media queries (responsive
  collapse, `prefers-reduced-motion`) are a different matter and fine.
- Dark values are re-picked, not inverted: soft grounds go deep and desaturated,
  accents brighten to hold contrast.

## Type and layout non-negotiables

- Canvas ≤1080 px; running paragraphs measure ≤68 ch inside it (structured
  list rows — non-goals, acceptance — may run to ~82 ch). Wide figures scroll
  in their own `overflow-x: auto` wrapper; the body never scrolls sideways.
- Body: the sans stack, 15–16 px, line-height ~1.6. Mono is for eyebrows,
  labels, data, and code **only** — mono body text or mono headings read as a
  terminal dump, which is the look this skill exists to replace.
- h1 ~34 px weight 650 letter-spacing −0.015em; h2 ~21 px; both
  `text-wrap: balance`. Uppercase mono eyebrows at 10.5–11 px with 0.1–0.14em
  tracking.
- Section headers are `sec-head` rows: eyebrow + h2 on one baseline. Number
  eyebrows (`01 · topic`) only when the reading order carries information.
- Space with flex/grid `gap`; `tabular-nums` wherever digits align; radii on
  one scale (4/6/8/10 px, 99px pills); real links and controls get hover
  states — mockup chrome is a picture, hover there is an optional hint; any
  animation sits behind `prefers-reduced-motion: no-preference`.

## Component grammar — route by what the concept is

| The concept is                                      | Component (all in scaffold)                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Page identity + load-bearing decisions              | `header.page`: eyebrow · h1 · `.lede` · `.chip` meta-row                                                        |
| A UI or product surface the page proposes/describes | `.mock` surface mockup — toolbar, optional rails, dotted canvas, positioned `.node`s, SVG edge layer, inspector |
| Linear pipeline whose stages carry build/gate state | `.strip` flow strip: `.fbox` variants + labelled `.arrow`s                                                      |
| Ordered passes through a system                     | `.steps` counter cards, top border encoding state                                                               |
| Enumerable facts, N items × M properties            | table with mono uppercase `th`, `.tag` state pills                                                              |
| Delivery slices with estimates                      | `.phases` cards with `.est` pill and a `ship:` line                                                             |
| Ordered messages between ≤6 participants            | `.seq` lane figure — CSS lifelines + offset messages, no runtime                                                |
| Verifiable done-criteria                            | `.accept` checklist rows — these become the implementation's test targets                                       |
| Refused scope                                       | `.nongoals` ✕ rows: bold claim + muted why                                                                      |
| A state code the figures share                      | `.legend` key swatches, once, above the first figure using it                                                   |
| Evidence the page rests on                          | `footer` grounding block                                                                                        |

The **surface mockup** is the flagship and the reason a designed page beats a
themed one: when the page is about a UI, draw that UI — frame, toolbar with a
live `status-pill`, rail listing real items, dotted-grid canvas with
`position:absolute` nodes, and an `.edges` SVG layer (cubic béziers, marker
arrowheads, edge labels) sized to the canvas `viewBox`. State lives in dots,
badges, border variants; the selected node's detail appears in the inspector.
Keep side rails ≤430 px combined at a 1080 canvas so the canvas keeps ~640 px.
Keep edge endpoints on node borders — measured from the rendered DOM (workflow
step 5), recomputed whenever a node moves or its text rewraps.

Escalate beyond the grammar when the concept outgrows it: hand-drawn
architecture and anything with loop-backs or trust boundaries → the `diagram`
skill (inline its SVG in a figure block); message exchanges of >6 participants,
alt/loop fragments, or state machines → mermaid where the host renders it, else
the `diagram` skill. Inventing a component above the grammar's floor is
encouraged when the subject demands one — keep it on the page's tokens. Never
ASCII art.

## Do not ship the templated look

Where the user pins a direction, follow it exactly. Otherwise never spend the
freedom on: warm-cream + serif + terracotta; near-black + lone acid accent;
purple-to-blue gradient hero; Inter/Space Grotesk as the reflex face; emoji
section markers; everything centered; `rounded-lg` everywhere; a fixed house
theme reused for a page that deserved its own palette. A pure mid-grey neutral
reads as unconsidered — bias it toward the accent.

## Precedence

User's words > the project's design system > this skill. But scale honors what
exists: a **complete** design system (component library, brand tokens) is
applied, not overridden; a **base stylesheet** (a shared `design.css` with a
handful of tokens) is a floor — keep its variable names where they exist,
match its neutrals, and build this skill's token layer and components on top,
page-scoped. A thin shared stylesheet is never a reason to ship a flat page.
