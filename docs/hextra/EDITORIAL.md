# Docs editorial standard

The docs at agentkit.sbs are product documentation read by every user. They are
user-focused: lead with what the system does and how to use it, state design
boundaries as facts, and give the configuration or workaround as the
instruction. Accuracy is never sacrificed — framing is.

## Callout policy (mechanically enforced)

Callouts are the Hextra shortcode, `{{< callout type="…" >}}`, and the theme's
vocabulary is `info` / `warning` / `error`.

`tests/docs/docs-tone.test.ts` fails the suite when a page violates this:

- **`error` is not used.** It is the escalation Starlight spelled `danger`, and
  nothing in these docs warrants a red box.
- `warning` is this theme's ordinary emphasis callout rather than the rare,
  reviewed escalation `caution` was, so it carries no allowlist.
- Everything else is prose or `info`.

## Version picker retention

Candidates come from `data/archives.json`, not from the git tags: archives are
never rebuilt, so a tag whose tree was never published here would put a 404 in
the picker. History restarts at the move to `docs.agentkit.sbs` — earlier trees
were built for a different URL scheme and their in-content links point at it.

`scripts/versions.ts` keeps every published patch of the minor shipping now,
plus the last patch of each older minor, and labels the rest `(archived)`. A
release publishes its own tree under `/<version>/` at deploy time and appends
that version to `archives.json`, which is also the spare-list the deploy's prune
reads. Trimming a long history is what the rule is for; dropping the release
that shipped last week is not, and that is the one a reader most wants back.

## Voice

- Never present a limitation as a defect of the product ("silently off",
  "there is no X", "worse than no guard"). Say what the boundary is, why it is
  drawn there, and what the user does instead.
- Scope statements are neutral: "Codex policies match argv prefixes; recursive
  payload analysis lives in the Claude hook and OpenCode plugin" — not "this is
  a weakness".
- A fixed bug's history belongs in the changelog, not in a warning box on the
  feature's page.
