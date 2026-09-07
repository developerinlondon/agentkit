---
title: Cookbook
weight: 3
cascade:
  type: docs
---

Complete, copyable shapes. Commands, files, and what you should see back.

## Ask your agent

The shortest path to most of what follows is a sentence, in any harness agentkit is installed
into. The agent picks the details.

```text
# set a machine up (or run bootstrap.sh yourself)
Install agentkit and set it up on this machine. Follow
https://raw.githubusercontent.com/developerinlondon/agentkit/main/README.md

# living architecture docs for the current repo
Use the architect skill to document this repo's architecture and publish it as a page.

# an evidence-backed brief about any product
Use product-intelligence to research <url> and publish the brief.
```

The second and third rely on skills auto-triggering from their descriptions. `architect` is a core
skill; `product-intelligence` needs `--with product`.

## The recipes

| Recipe                                                            | Needs                         |
| ----------------------------------------------------------------- | ----------------------------- |
| [Publish a page](/cookbook/publish-a-page/)                       | core, plus `bun`              |
| [Gate a merge on a review record](/cookbook/gate-a-merge/)        | `--with adversarial-review`   |
| [Contain a heavy build](/cookbook/contain-a-build/)               | Linux, provisioned work slice |
| [Declare what your repo ships](/cookbook/declare-your-product/)   | `--with product`              |
| [Override a guard, once, on purpose](/cookbook/override-a-guard/) | core                          |
| [Find what is half done](/cookbook/find-what-is-half-done/)       | core                          |
| [Name the person at the keyboard](/cookbook/name-the-editor/)     | core                          |
