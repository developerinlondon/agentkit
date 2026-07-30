---
title: Publish a page
description: Turn a markdown file into a live URL with a stable, deterministic
  address you can republish over.
sidebar:
  order: 2
slug: 0.4/cookbook/publish-a-page
---

Write markdown, publish it through a theme, get a stable URL. Republishing the same `--name`
updates the same page.

One-time setup per machine, because the skill ships its own dependencies:

```sh
cd ~/.agentkit/skills/publish-page && bun install
```

Then:

```sh
bun ~/.agentkit/skills/publish-page/publish.ts \
    --name auth-flow-design --file design.md --template doc
```

It prints the live URL, `https://pages.agentkit.sbs/<slug>`.

The slug is `HMAC(key, name)` — cryptic hex nobody can guess, but **deterministic**. The same name
republished updates the same URL, and `--delete --name <name>` finds it again. There is no mapping
to store.

```sh
# slides instead: markdown sections split on --- lines
bun ~/.agentkit/skills/publish-page/publish.ts \
    --name q3-roadmap --file roadmap.md --template deck --title "Q3 roadmap"

# a human-readable URL instead of the cryptic one (up to 4 path segments)
… --slug design/auth-flow --file design.md

# take it down
… --name auth-flow-design --delete
```

## Templates

| Template | For                                           |
| -------- | --------------------------------------------- |
| `doc`    | reports and articles (default)                |
| `deck`   | slides — markdown split on `---` lines        |
| `raw`    | complete self-contained HTML, published as-is |

## Constraints worth knowing before you write

- **Self-contained only.** The serving CSP blocks every external request. Inline the CSS and JS,
  embed images as data URIs.
- **5 MB cap** on the rendered page.
- The `doc` and `deck` themes carry the house style, a persisted dark/light toggle, a TOC dot rail
  on docs with three or more `h2` sections, click-to-expand figures, and deck navigation. Do not
  re-implement any of it.

:::tip[Verify before you report the URL]
The skill's own instruction is to load the printed URL in headless Chromium at ~1280 px, screenshot
both themes, and read every figure before handing the link over. A clipped or illegible figure
means fix and republish. Never report the URL of an unviewed page.
:::

How the URL is derived, and what happens on key rotation: [Pages](/docs/0.4/concepts/pages/).
