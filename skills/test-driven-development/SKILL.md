---
name: test-driven-development
description: >-
  Enforces strict Test-Driven Development (TDD) workflow: RED-GREEN-REFACTOR cycle.
  Tests MUST be written BEFORE implementation. Every change starts with a failing test.
  Applies to any language (Rust, TypeScript, Python, Go, etc.).
  Triggers: writing new features, fixing bugs, adding endpoints, refactoring, any code change.
---

# Test-Driven Development (TDD)

## The Cycle (NON-NEGOTIABLE)

Every code change follows this exact sequence:

1. **RED** — Write a test that describes the desired behavior. Run it. It MUST fail.
2. **GREEN** — Write the MINIMAL code to make the test pass. Nothing more.
3. **REFACTOR** — Clean up while keeping tests green. Remove duplication, improve naming.

**No code without a test. No test without seeing it fail first.**

## When to Apply

TDD applies to ALL code changes:

- **New features**: Test the behavior before writing it
- **Bug fixes**: Write a test that reproduces the bug, THEN fix it
- **Refactoring**: Ensure tests cover the behavior before changing implementation
- **API endpoints**: Test request/response contract before implementing the handler
- **CLI commands**: Test arg parsing and output before wiring the command
- **Data models**: Test serialization/deserialization before defining structs

## Workflow Steps (Detailed)

### Step 1: Write the Test

- Write a test that describes WHAT the code should do, not HOW
- Use descriptive test names: `user_login_returns_token`, not `test1`
- Test one behavior per test function
- Include edge cases and error paths

### Step 2: Verify RED

- Run the narrowest focused test that demonstrates the behavior
- Confirm the new test FAILS
- Confirm it fails for the RIGHT REASON (missing function, wrong return value — not a syntax error)
- If the test passes immediately, it's not testing new behavior — rewrite it

### Step 3: Implement (Minimal)

- Write ONLY the code needed to make the failing test pass
- Do not add extra features, optimizations, or "while I'm here" changes
- Do not write code that isn't covered by a test

### Step 4: Verify GREEN

- Run the focused RED test plus the affected regression slice
- All selected tests must pass — new AND existing
- If existing tests break, fix the implementation, not the tests

### Step 5: Refactor

- Clean up duplication, improve names, extract helpers
- Run the focused tests after every refactor step to ensure nothing breaks
- This is where you improve code quality — not during GREEN

### Final-head verification

RED and GREEN are fast feedback loops, so keep their checks focused. Before
freezing the source head, resolve review effort with `review-profile`. Run the
affected suite for `local-checks: affected`, or the full suite for
`local-checks: full` and whenever target policy requires it.

Run any required full suite once on the final exact head, not after every GREEN
or refactor. Passed CI bound to that exact SHA is authoritative evidence when
the profile selects `ci-evidence: reuse`; repeat it locally only when evidence
is missing or inconsistent, or `ci-evidence: rerun` is selected. A later commit
invalidates the result and requires final-head verification again.

## Anti-Patterns (BLOCKING violations)

- Writing implementation before tests
- Writing tests that pass immediately (never saw RED)
- Skipping the RED verification step ("I know it'll fail")
- Writing tests after the fact to "backfill coverage"
- Deleting or modifying tests to make them pass instead of fixing code
- Writing too much implementation at once (should be incremental)
- Testing implementation details instead of behavior
- Skipping the refactor step

## Test Quality Standards

- Each test should be independent — no shared mutable state between tests
- Tests should be fast — mock external dependencies (network, filesystem, databases)
- Test names should read like specifications
- Prefer `assert_eq!` over `assert!` for better failure messages
- Test error paths, not just happy paths
- One logical assertion per test (multiple `assert_eq!` on the same result is fine)

## Bug Fix Protocol

When fixing a bug:

1. Write a test that REPRODUCES the bug (fails with current code)
2. Verify the test fails — this proves you understand the bug
3. Fix the bug with minimal changes
4. Verify the test passes — this proves the fix works
5. The test now permanently guards against regression
