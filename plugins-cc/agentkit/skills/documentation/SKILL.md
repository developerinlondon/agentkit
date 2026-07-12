---
name: documentation
description: >-
  Documentation standards: surface-aware diagrams (Mermaid where markdown renders, ASCII for
  terminals and diffs), structured plan format, compact tables for comparisons. Use when writing
  docs, plans, READMEs, or architecture documents in any project.
---

# Documentation Standards

## Diagrams

Pick the diagram format by where the document is primarily read:

- Rendered markdown (READMEs, docs sites, GitLab/GitHub issues and MRs, chat UIs with Mermaid
  support): use `mermaid` code fences (`flowchart LR`/`TD`, `sequenceDiagram`) -- they render as
  real diagrams. Keep them compact (<= ~10 nodes) and label the edges.
- Plain text (plans and notes read in editors, terminals, git diffs, any monospace surface): use
  ASCII box-drawing diagrams with + - | / \ > < =, wrapped in triple-backtick code blocks (no
  language tag). Max ~40 lines, ~80 chars wide.
- For data flow: use arrows ---> and ---- with labels
- For hierarchy: use tree notation +-- |

## Plan Files

- Plans should include: Status, Created date, Dependencies, Architecture diagram, Task list
- Task items use checkbox format: `- [ ] description`

## Format

- Always run the project's formatter on markdown files after editing
- Use tables for structured comparisons
- Use code blocks with language tags for all code/config snippets
- Keep lines under 100 characters where possible
