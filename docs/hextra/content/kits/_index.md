---
title: Kits
weight: 2
cascade:
  type: docs
---

Skills are partitioned into **kits**. `core` always installs; everything else is opted into, and the
selection is remembered so the next bare install run reproduces it.

{{< kit-table >}}

Kit membership is declared in one manifest, `skills/KITS`, read by a shared library so the
installer, the plugin generator and this page can never disagree. A skill with no record belongs to
`core`, and a skill may name only one kit.

## Three ways a kit gets selected

```sh
./install.sh --global --with product          # add one, and remember it
./install.sh --global --all                   # every declared kit except the explicit ones
./install.sh --global --without product       # drop it, and remember that too
./install.sh --global                         # reproduce the remembered selection
```

The remembered set lives in `~/.agentkit/kits` and is written only by a global install.

## Explicit kits are consent-gated in both directions

Two kits are marked `explicit` in the manifest: `adversarial-review` and `advisory-review`. They are
never offered by the interactive picker and are **excluded from `--all`**. Only a literal
`--with <kit>` selects one.

{{< callout type="warning" >}}
When an explicit kit is not selected, the installer does not merely skip it — it **removes** what it
previously installed for it: hooks, tools, skills, instruction files, and the entries in
`settings.json` and Codex's `hooks.json`. Presence without recorded selection is not consent for a
consent-gated kit.
{{< /callout >}}

The same removal rule applies to ordinary optional kits. Deselecting `memory` or `product` removes
their managed skills, hooks, settings entries, prompts and plugins — otherwise a harness would go on
discovering and auto-triggering a workflow the user removed.

`explicit` therefore controls how a kit is **selected**, not how it is removed.

## When the wizard appears

The interactive picker is narrow on purpose. It runs only when **all** of these hold:

| Condition                                  | Why                                                        |
| ------------------------------------------ | ---------------------------------------------------------- |
| the install is `--global`                  | project installs never write the remembered set            |
| stdin is a terminal                        | a piped `curl … \| bash` has no terminal, so it cannot ask |
| `--no-prompt` was not passed               | the explicit opt-out                                       |
| `AGENTKIT_SKIP_PROMPT` is unset            | the environment opt-out, for CI                            |
| `CI` is unset                              | CI is never interactive                                    |
| no `--with`/`--without`/`--all` was passed | you already stated the selection                           |

That is why the bootstrap one-liner installs `core` only unless you pass `--with <kit>`: piped
stdin is not a terminal, so the question never fires.

## The manifest validator

The installer validates `skills/KITS` before it writes anything. It catches the typos nothing else
can:

- a membership line that lost its kit name — it would fall through to `core` and ship that skill to
  everyone
- two memberships for one skill — the bash and TypeScript readers resolve first-match and last-match
  respectively, so the two would ship different sets
- an `explicit` marker or a membership naming a kit that was never declared

Any of them aborts the run before a file is touched.

## What is in each kit

{{< tabs >}}
{{< tab name="core" >}}{{< skill-table kit="core" >}}{{< /tab >}}
{{< tab name="memory" >}}{{< skill-table kit="memory" >}}{{< /tab >}}
{{< tab name="product" >}}{{< skill-table kit="product" >}}{{< /tab >}}
{{< tab name="clickup" >}}{{< skill-table kit="clickup" >}}{{< /tab >}}
{{< tab name="adversarial-review" >}}
{{< skill-table kit="adversarial-review" >}}

Also installs `review-police`, the `review-gate` and `review-profile` tools, and the
`evidence-gated-review` instruction. See [review and the gate](/guide/concepts/review/).
{{< /tab >}}
{{< tab name="advisory-review" >}}
This kit carries no skills. It installs one always-on instruction, `review-discipline.md`, which
asks for one non-authoring reviewer pass per substantive change. Nothing enforces it.
{{< /tab >}}
{{< /tabs >}}
