---
title: Publish a page
description: Turn a markdown file into a live URL with a stable, deterministic address you can republish over.
sidebar:
  order: 2
---

Write markdown, publish it through a theme, get a stable URL. Republishing the same `--name`
updates the same page.

The skill ships a `package.json`, so the installer already ran `bun install` in it — and its build
script, if it has one. That only happens when a usable `bun` was on `PATH` at install time; if it
was not, the installer warned and you finish the job by hand:

```sh
cd ~/.agentkit/skills/publish-page && bun install
```

Publish:

```sh
bun ~/.agentkit/skills/publish-page/publish.ts \
    --name auth-flow-design --file design.md --template doc
```

It prints the live URL, `https://pages.agentkit.sbs/<slug>`.

On the first publish, the command opens `account.agentkit.sbs/device` and prints a short code. Sign in
with Assay and approve that device. The resulting credential belongs only to that account and device;
later publishes reuse it. New pages are private and appear at `https://account.agentkit.sbs/dashboard`,
where the owner can create a revocable sharing link or invite another verified Assay email.
The same dashboard lists publishing devices so a lost or retired machine can be revoked.

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

# explicitly archive the source and rendered page in the canonical clone
… --name auth-flow-design --file design.md --git
```

## Templates

| Template | For                                           |
| -------- | --------------------------------------------- |
| `doc`    | reports and articles (default)                |
| `deck`   | slides — markdown split on `---` lines        |
| `raw`    | complete self-contained HTML, published as-is |

A rendered deck is worth more than a description of one:
[the publish-freshness deck](/docs/examples/publish-freshness-deck.html) is six slides built from
[its markdown source](/docs/examples/publish-freshness-deck.md) through the `deck` template — cover
with a stat row, a severity callout, a stage flow, legend rails, and column cards. Arrow keys, space
and swipe move between slides; the toggle in the nav bar flips the theme.

## Callouts

A callout is an aside with a coloured rail and a label. Pick the severity by consequence, not by
mood: `warn` for a cost or a constraint, `alarm` for something that breaks or exposes if ignored,
`ok` for a confirmed-good result, `note` for a quiet aside, and no class at all for a neutral one.

```html
<div class="callout warn"><strong>Heads up.</strong> body text</div>
```

The label is whatever **opens** the callout, and four spellings mean the same thing — they render
identically, at the same height, with the label taking the colour of its own rail:

| Spelling   | What you write                                                                           |
| ---------- | ---------------------------------------------------------------------------------------- |
| Inline     | `<div class="callout"><strong>Label.</strong> body</div>`                                |
| Blank line | a blank line inside the div, then `**Label.** body` — markdown wraps the body in a `<p>` |
| Wrapped    | you supply the `<p>` yourself                                                            |
| Heading    | a leading `<h3>`                                                                         |

Bold that does **not** open the callout stays body text: a phrase mid-sentence, a phrase after a
plain opening, a second `<h3>` further down. That distinction is made when the page is rendered,
not by a CSS selector — `:first-child` counts element children, so it cannot see the text sitting
in front of a bold phrase and would promote it to a title.

:::note[The corollary]
Whatever opens a callout becomes its label. Do not open one with emphasis you did not intend as a
title — put the plain words first instead.
:::

Severity rides the rail and the label only. Body text stays in ink in both palettes, and every
pairing the themes actually paint is contrast-checked at 4.5:1.

## Constraints worth knowing before you write

- **Self-contained only.** The serving CSP blocks every external request. Inline the CSS and JS,
  embed images as data URIs.
- **5 MB cap** on the rendered page.
- **Private by default.** `--git` is separate archival and can expose content according to the
  canonical repository's own visibility; use it only when that is intended.
- The `doc` and `deck` themes carry the house style, a persisted dark/light toggle, a labelled
  section nav on docs with three or more `h2` sections, click-to-expand figures, and deck
  navigation. Do not re-implement any of it.
- The section nav names each tab from its `h2`. A title longer than about 28 characters is
  shortened and marked with an ellipsis to say the label was derived rather than chosen — write
  `<h2 data-nav="Estimate">Two to four weeks, not two months</h2>` to name it yourself.
- The nav's left slot is opt-in: a `<div class="brand">Name</div>` anywhere in your content is hoisted
  into the bar, with its accent mark drawn for you. Without one the slot stays empty.

:::tip[Verify before you report the URL]
The skill's own instruction is to load the printed URL in headless Chromium at ~1280 px, screenshot
both themes, and read every figure before handing the link over. A clipped or illegible figure
means fix and republish. Never report the URL of an unviewed page.
:::

How the URL is derived, and what happens on key rotation: [Pages](/docs/concepts/pages/).
