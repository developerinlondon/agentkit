---
title: Declare what your repo ships
description: A .agentkit/product.yaml that makes your repo product-reviewable — built, run and used, not just read as a diff.
sidebar:
  order: 5
---

`product-review` is a review lane that meets the product the way a user does: it builds it, runs
it, and uses it. It reads `.agentkit/product.yaml` to know how. Needs `--with product`.

```yaml
summary: >-
  One or two sentences about what this product IS, from a user's point of view.
  Not the architecture — what someone uses it for.

surfaces:
  - name: api
    kind: service # cli | service | web | desktop | library | api
    build: bun install && bun run build
    verify: bun test
    run: bun run start
    expect: |
      A signup completes and the new user appears in GET /api/users.
      POST /api/items returns 201 and the item reads back.

requires:
  credentials:
    - name: DATABASE_URL
      how: any Postgres 16; `docker compose up db` provides one
  notes:
    - the email surface needs outbound SMTP, unreachable in CI
```

`surfaces` is a **list**. Every other field is optional — but the fewer you declare, the less a
reviewer can verify, and it says so plainly in its report rather than implying coverage.

## The fields that matter most

| Field      | Why it earns its place                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `build`    | run verbatim from the repo root, in order. Put the flags here, not in prose.                                   |
| `verify`   | must **fail loudly** when the product is broken. `--help` and `--version` verify nothing.                      |
| `run`      | how to get it up.                                                                                              |
| `expect`   | plain language: what to look at once it is running. This is where "it builds" becomes "it works".              |
| `requires` | what cannot be verified in some environments, and why. An unstated requirement becomes a false "works for me". |

Never put secret **values** in this file. Name the credential and say where it comes from.

The reviewer looks for the nearest `.agentkit/product.yaml` walking up from the change, so a
monorepo can declare one per package.

## Without the file, it refuses

```text
No .agentkit/product.yaml in this repo, so I cannot product-review it —
I would be guessing at how to build and run it. Add one (template:
product.example.yaml) describing the user-facing surfaces, or tell me
the build/run/verify commands and I will review against those.
```

It then records the absence as verdict `unable_to_verify`, coverage `none`, and a MEDIUM finding
reading "no product manifest — product surfaces unverified".

:::note[Refusing is the correct behaviour]
A review that invents its own idea of the product is worse than none. It does not fall back to
guessing `bun run build`, and it does not return a silent pass — it reports the lane as unverified.
:::

The template ships with the skill, at `~/.agentkit/skills/product-review/product.example.yaml`.
agentkit dogfoods it: this repository's own `.agentkit/product.yaml` declares a `test-suite` surface
and a `plugin` surface.

Why the declaration is committed rather than inferred: [The product model](/docs/concepts/product/).
