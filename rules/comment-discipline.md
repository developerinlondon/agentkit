---
globs: "**/*.{ts,tsx,js,jsx,py,rb,go,rs,java,kt,cs,cpp,c,h,hpp,swift,scala,vue,svelte,sh,bash,yaml,yml,toml,Dockerfile,Dockerfile.*}"
---

# Comment Discipline (Comment Police)

Default to writing **no comments**. Add one only when the WHY is non-obvious and removing it would confuse a future reader without conversation context. Bad comments rot, lie, and bloat the codebase.

## 1. Forbidden Patterns (the comment police flags these)

- **Multi-paragraph rationale blocks** above functions, jobs, steps. The PR description / commit message is where rationale lives.
- **References to the current PR / task / commit / plan**: `closes #N`, `Plan-15 slice 2`, `for the v0.14.0 flow`, `added when we did X`. These rot the moment the surrounding code changes.
- **Any forge reference at all**, including bare ones agents reach for reflexively: `(#170)`, `some-repo!31`, a GitLab/GitHub issue or MR URL, a commit sha. The durability argument is the whole point: a comment lives as long as the repo, but issues and merge requests live in the **forge**. Clone the repo elsewhere, or migrate forges, and the pointer dangles — the reasoning is unreachable exactly when someone needs it. Three homes are durable and travel with the code: the comment itself (state the reason, don't link to it), the commit message (traceability), and an in-repo design doc (decisions worth keeping). A merge request is none of them.
- **WHAT-narration**: comments that re-state what the code clearly does (`# call API`, `// loop over items`, `# release jobs run after binaries succeed`).
- **Tutorial-style top-of-file headers** longer than ~10 lines describing how to use the file. README / docs are the right home.
- **Documenting default values** that are visible two lines below.
- **Step-by-step narratives** ("first we do X, then Y, then Z") inside functions that already have those exact steps.

## 2. What's Worth Keeping

A comment passes the bar if all of these hold:

- The WHY is genuinely non-obvious from the code
- Removing it would confuse a future reader without conversation context
- The information is durable (won't rot when surrounding code changes)
- It's about ONE of: hidden constraint, subtle invariant, workaround for a specific external bug, behavior that would surprise

Examples that pass:

```rust
// PG's `CREATE SCHEMA IF NOT EXISTS` races across processes — the
// catalog insert happens before the existence check. Catch 23505 here.
```

```yaml
# musl-tools must be apt-installed because dtolnay/rust-toolchain
# doesn't pull cross-compile system deps.
```

```ts
// Docker doesn't expand ARG inside `--from`; we use a picker stage.
```

Examples that fail:

```rust
// Plan-15 slice 2 lifted the workflow-API auth gate to the engine layer.
// Now release jobs run after binaries; we removed the bumped gate.
// See PR #77 for the rationale on why we picked the artifact-download path.
```

(Three sins: PR reference, narrating WHAT changed, WHY belongs in commit.)

## 3. Implementation Strategy

- **Write code first, comments last** (or never). After writing a function, ask "would deleting every comment in this function leave it confusing?" If no, delete them.
- **If you're explaining the code, fix the code instead.** Rename the variable, extract a helper, restructure — most "needed" comments mean the code isn't reading clearly.
- **PR description / commit message is the durable home** for _why this change was made_. Don't duplicate that into the code.
- **Comment-to-code ratio** in any single file edit should generally stay below ~30%. The comment police plugin will warn above that on writes.
- Don't wait for the comment police plugin to warn — discipline is built-in, not retro-fitted.
