---
name: project-planning
description: >-
  Structured project planning: break down a new project idea into plan files covering
  architecture, file structure, and implementation roadmap. Triggers: 'new project',
  'plan a feature', 'break down', 'architecture', 'roadmap', 'design a system'.
---

# Project Planning

## When NOT to Use

- Trivial single-file changes or bug fixes
- Features that fit entirely in one file
- Refactors with no architectural decisions

## Process

1. Ask clarifying questions to understand the project idea fully
2. Create `00-plan.md` first -- get approval before continuing
3. Create `01-architecture.md` -- get approval for the technical design
4. Create remaining plan files
5. Create `AGENTS.md` last (it summarises decisions from the plan files)
6. Set up `dprint.json` for markdown formatting

## Directory Structure

```
.claude/plans/
├── 00-brainstorm/          (optional: early-stage research)
│   └── 00-plan.md
└── 01-implementation/
    ├── 00-plan.md          (overview, problem, solution, estimates)
    ├── 01-architecture.md  (system design, ASCII diagrams, data flow)
    ├── 02-file-structure.md (module/package/crate layout)
    ├── 03-roadmap.md       (sprints with tasks and time estimates)
    ├── 04-wireframes.md    (optional: UI screens in ASCII art)
    └── 05-user-workflows.md (optional: end-to-end user scenarios)
```

## What Goes in Each File

### 00-plan.md

Include a header block with: created date, status, repo name, and links to the other plan files.

Body covers:
- Problem statement (what pain does this solve?)
- What makes it unique (vs existing tools)
- Target users and their context
- Integration points with other systems
- All time estimates in AI agent time (see Estimation Rules below)

### 01-architecture.md

- High-level system diagram in ASCII (NOT Mermaid)
- Module/crate dependency graph
- Data flow diagrams
- Database schema (if applicable)
- Key traits, interfaces, or contracts

Wrap every diagram in a triple-backtick code block with no language tag.

### 02-file-structure.md

Full directory tree with inline annotations explaining each module's purpose.

- Rust projects: workspace layout + per-crate breakdown
- TypeScript projects: package structure + key files
- Annotate non-obvious directories with a short comment

### 03-roadmap.md

Break implementation into numbered sprints. Sprint 0 is always project scaffolding.
The final sprint is always polish and release prep.

Each sprint includes:
- Numbered task list with per-task AI time estimates
- Sprint total estimate
- Quality gate: what must pass before the next sprint starts
- Dependencies on other sprints

### 04-wireframes.md (optional)

ASCII art wireframes for each UI screen or view. Include a navigation flow diagram
showing how screens connect. One diagram per screen.

### 05-user-workflows.md (optional)

Step-by-step scenarios showing how a user accomplishes a goal end-to-end.
Cover the happy path and at least one error or edge case per workflow.

## Estimation Rules

- NEVER give human developer time estimates
- All estimates are AI agent time: 16h/day throughput, roughly 4x human speed
- Include per-task estimates AND sprint totals
- Sprint 0 (scaffolding) is typically 2-3 hours AI time
- Label estimates clearly: `[AI: 1.5h]` or `[AI: 30min]`

## AGENTS.md

Create at the repo root after the plan files are approved. Include:

- **Project context**: name, repo, current phase, active branch, plan file locations
- **Post-edit hooks**: formatter command, ASCII box fixer if used
- **Key architecture decisions**: bullet points, one decision per line
- **Anti-patterns**: things to NEVER do in this codebase (specific to this project)
- **Dependencies**: key libraries and the reason each was chosen

## Diagram Rules

- ASCII only -- no Mermaid, no SVG, no image files
- Box-drawing characters: `+`, `-`, `|`, `/`, `\`, `>`, `<`
- Max ~40 lines tall, ~80 chars wide per diagram
- Data flow: use `---->` arrows with labels
- Hierarchy: use `+--` and `|` tree notation
- Always wrap in triple-backtick code blocks
