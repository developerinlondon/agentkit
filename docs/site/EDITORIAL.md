# Docs editorial standard

The docs at agentkit.sbs are product documentation read by every user. They are
user-focused: lead with what the system does and how to use it, state design
boundaries as facts, and give the configuration or workaround as the
instruction. Accuracy is never sacrificed — framing is.

## Callout policy (mechanically enforced)

`tests/docs/docs-tone.test.ts` fails the suite when a page violates this:

- **`:::danger` is not used.** Nothing in these docs warrants a red box.
- **`:::caution` is reserved for user-protective warnings** — data loss,
  irreversible operations, prerequisites whose absence breaks an install. Each
  caution is allowlisted in the test by file and title; adding one is a
  deliberate, reviewed act.
- Everything else is prose, `:::note`, or `:::tip`.

## Voice

- Never present a limitation as a defect of the product ("silently off",
  "there is no X", "worse than no guard"). Say what the boundary is, why it is
  drawn there, and what the user does instead.
- Scope statements are neutral: "Codex policies match argv prefixes; recursive
  payload analysis lives in the Claude hook and OpenCode plugin" — not "this is
  a weakness".
- A fixed bug's history belongs in the changelog, not in a warning box on the
  feature's page.
