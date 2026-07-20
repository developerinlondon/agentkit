---
name: product-review
description: >-
  Review a product the way a user meets it — build it, run it, use it — instead of
  reading a diff. Consumes .agentkit/product.yaml; refuses and asks when it is
  missing rather than guessing. Use alongside diff review, never instead of it.
---

# Product Review

Diff review asks "is this change correct?". Product review asks **"can someone
actually build, install and use this?"** Those catch different defects, and the
second one is routinely skipped because nothing in a diff points at it.

Concretely, diff-scoped reviewers cannot see: a stale build command in a
README, a default configuration that produces a broken-looking install, missing
packaging, a setup step that only exists in someone's head. None of it appears
in a diff, so none of it gets caught — until a user hits it.

## The manifest is the contract

Read `.agentkit/product.yaml` (template: `product.example.yaml` in this skill).
It declares the surfaces, the commands to build/verify/run each one, what the
environment must provide, and what is known-unverifiable.

**If it is missing, STOP. Do not review.** Report exactly this and end:

> No `.agentkit/product.yaml` in this repo, so I cannot product-review it —
> I would be guessing at how to build and run it. Add one (template:
> `product.example.yaml`) describing the user-facing surfaces, or tell me
> the build/run/verify commands and I will review against those.

Then **record the absence as a finding** in the review record, severity MEDIUM,
summary "no product manifest — product surfaces unverified". Do NOT return a
silent pass. A missing manifest that ends the review quietly makes "don't add
the file" the cheapest way to dodge product review, and turns an unreviewed
product into one that looks reviewed.

Never invent the commands yourself. Inferring a build from the file tree is
exactly the guess that produces a confident, wrong report.

## Running it

1. **Build each surface** with its declared `build`. A build failure is a
   BLOCKER — it means the product cannot be obtained at all.
2. **Run `verify`.** If it cannot fail (`--help`, `--version`, a test suite
   with no assertions), say so: a verification that always passes is not
   evidence, and reporting it as one is the defect this skill exists to stop.
3. **Run the surface** and compare against `expect`. This is where "it
   compiles" becomes "it works".
4. **Follow the setup as written**, from a cold start, exactly as declared. Do
   not fill in a missing step from your own knowledge of the repo — a step you
   supply silently is a step the user will be missing. That gap IS the finding.

## Environments where you cannot run it

Common for client repos: no hardware, no credentials, no network. That is
expected and is not a reason to fabricate coverage.

Verify what you can, and **state plainly what you could not**, per surface:

> Verified: builds clean; test suite passes (146 tests).
> NOT VERIFIED: the daemon was never run — no macOS host available. The
> menu-bar icon, pairing flow and voice path are unchecked.

Honest partial coverage is useful. "Looks good" over an unrun product is worse
than no review, because it launders an assumption into a verdict. Anything in
the manifest's `cannot_verify` list is reported as not verified, with its
reason — never quietly dropped.

## What to report

Findings in the same shape as a diff review (`severity`, `summary`, plus a
concrete failure scenario), written from the user's position:

- **BLOCKER** — cannot build, cannot install, or the primary surface does not
  work when followed as documented.
- **HIGH** — a documented command is wrong or a required step is missing, so a
  user following the docs ends up with a broken or half-working install.
- **MEDIUM** — works, but a default, error message or setup step will
  predictably mislead (an install that looks broken rather than misconfigured).
- **LOW** — friction, rough edges, missing convenience.

Two rules carried over from diff review, because they were learned the hard
way: report what you actually observed rather than what the code implies, and
never describe coverage you did not obtain.

## Scope

Product review does NOT replace diff review — it adds the lens diff review
structurally cannot have. Run both. When they disagree about severity, the
user-facing consequence wins: code that is internally correct but unusable is
still broken.
