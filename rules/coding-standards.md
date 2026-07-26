---
globs: "**/*.{ts,tsx,js,jsx,py,rb,go,rs,java,kt,cs,cpp,c,h,hpp,swift,scala,vue,svelte}"
---

# Coding Standards (Coding Police)

Enforce these standards proactively to ensure the codebase remains modular, DRY, and maintainable.

## 1. Modularize by Default

- **File Length Limit**: No single file should exceed **1000 lines**.
- If a file grows beyond this limit, split it into smaller modules based on functionality (e.g., `types.ts`, `helpers.ts`, `constants.ts`, `handlers.ts`).
- Prefer a directory of small files over one large monolithic file.

## 2. Keep Functions Focused

- **Function Length Limit**: No single function or method should exceed **100 lines**.
- Large functions are harder to test and reason about. Decompose them into small, composable helper functions.
- Each function should do exactly one thing.

## 3. DRY (Don't Repeat Yourself)

- **Zero Tolerance for Duplication**: Never copy-paste logic.
- If you find yourself writing the same **6+ lines** of code in two places, extract them into a shared function or utility module.
- Duplication is a major source of maintenance debt.

## 4. Single Responsibility

- **Export Limit**: In TypeScript/JavaScript, a single file should ideally have no more than **15 exports**.
- Too many exports usually indicate that a file has multiple responsibilities.
- Split files with excessive exports into focused modules.

## 5. Implementation Strategy

- Plan your file structure **before** writing large amounts of code.
- If you realize a feature requires 1000+ lines, create the directory structure and multiple files from the start.
- Do not wait for the "Coding Police" plugin to warn you — modularity should be built-in.

## Worktrees, not branches, in a shared clone

Assume another agent is working in any clone you did not just create. Creating a
branch there swaps the working tree under them mid-edit. Use a worktree:

```sh
git worktree add ../<repo>-wt/<name> -b <branch> origin/<default>
```

`git-police` refuses branch creation in a clone that has other worktrees.
Override with `AGENTKIT_ALLOW_SHARED_BRANCH=1` only when you know nobody else
is in it.
