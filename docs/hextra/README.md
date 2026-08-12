# agentkit docs — Hextra build

A parallel rebuild of the documentation on [Hextra](https://github.com/imfing/hextra) (Hugo),
alongside the shipped Astro Starlight site in `../site/`. **Nothing here is deployed.** The live
docs at `agentkit.sbs/docs/` are still built and published from `../site/`.

## Build it

```sh
./build.sh
```

Three steps, and any of them fails the build:

1. `scripts/facts.ts` regenerates `data/agentkit.json` from the repository.
2. `hugo-extended` renders `content/` into `public/`.
3. `scripts/check-links.ts` walks the built HTML and fails on a dangling internal link.

### Prerequisites

| Tool              | Version | Why                                  |
| ----------------- | ------- | ------------------------------------ |
| Hugo **extended** | ≥ 0.146 | Hextra v0.10+ requires it            |
| Go                | ≥ 1.20  | Hugo modules fetch the theme         |
| bun               | any     | the facts generator and link checker |

Hugo extended is not the default build. `hugo env` must report `+extended`. Point `HUGO_BIN` at it
if the binary is not called `hugo-extended`:

```sh
HUGO_BIN=/path/to/hugo ./build.sh
```

## Preview it

The site is served under `/docs/`, and `public/` is the _contents_ of that prefix — so serving
`public/` at the web root gives 404s. Mount it under `docs/`:

```sh
mkdir -p /tmp/serve && ln -sfn "$PWD/public" /tmp/serve/docs
(cd /tmp/serve && python3 -m http.server 8792)
# http://127.0.0.1:8792/docs/
```

Or use `hugo-extended server`, which applies `baseURL` itself.

## Where the content comes from

Every reference table renders from `data/agentkit.json`, which
`scripts/facts.ts` derives from the tree by importing `collectFacts` out of
`../../scripts/sync-docs-facts.ts` — the same collector the Starlight site uses. A second reader of
the same tree would be a second thing to drift.

`scripts/facts.ts --check` fails when the committed data disagrees with the repository, which is
the hook a CI job would use.

Counts in prose come from `{{< count units >}}` and friends rather than being typed, because typed
ones drift: at the time of this build the live site's prose claimed twelve police units and
thirteen core skills against a tree holding fifteen and seventeen.

## Self-contained by requirement

The Worker serving this site sets a strict CSP, so FlexSearch and Mermaid are vendored into
`assets/js/vendor/` and referenced through `params.search.flexsearch.js` and `params.mermaid.js`
rather than Hextra's default CDN. A build that reintroduces a CDN reference will load nothing in
production and everything in local preview, so check:

```sh
grep -r "cdn.jsdelivr\|unpkg.com" public/ && echo "CDN reference — will be blocked in production"
```

## Shortcode gotchas

- `steps` and `details` need the **percent** form (`{{% steps %}}`) or their inner markdown is
  emitted raw. `callout`, `tabs`, `cards` and `filetree` take the angle form.
- A hand-written absolute link must carry the `/docs` prefix. Hugo does not apply `baseURL` to
  markdown links, only to `pageRef` menus and `relURL` in templates — so `/reference/hooks/` would
  404 in production while resolving in a preview served at the web root. `check-links.ts` catches
  it either way.
