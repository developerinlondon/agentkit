---
title: Discipline that executes
layout: hextra-home
---

{{< hextra/hero-badge >}}
  <div class="hx:w-2 hx:h-2 hx:rounded-none hx:bg-primary-400"></div>
  <span>Four harnesses, one canon</span>
{{< /hextra/hero-badge >}}

<div class="hx:mt-6 hx:mb-6">
{{< hextra/hero-headline >}}
  Instructions are advice.&nbsp;<br class="hx:sm:block hx:hidden" />Advice is skippable.
{{< /hextra/hero-headline >}}
</div>

<div class="hx:mb-12">
{{< hextra/hero-subtitle >}}
  agentkit makes working discipline executable: a hook that refuses at the tool&nbsp;<br class="hx:sm:block hx:hidden" />
  call, a gate that denies the merge, a runner that makes exceeding a memory&nbsp;<br class="hx:sm:block hx:hidden" />
  limit impossible. None of it depends on the agent remembering.
{{< /hextra/hero-subtitle >}}
</div>

<div class="hx:mb-6">
{{< hextra/hero-button text="Install it" link="guide/start/install/" >}}
</div>

<div class="hx:mt-12"></div>

{{< hextra/feature-grid >}}
  {{< hextra/feature-card
    title="Refusal, not advice"
    subtitle="Police units compiled into each harness's native extension mechanism. A force push, a `--no-verify`, an AI-attribution trailer, an unbounded build — refused at the tool call, with the legitimate override named in the message."
    link="guide/concepts/hooks/"
  >}}
  {{< hextra/feature-card
    title="One canon, symlink fans"
    subtitle="One copy under `~/.agentkit`, then per-name links into OpenCode, Claude Code, Codex CLI and Grok CLI. Skills you installed from anywhere else survive every upgrade untouched."
    link="guide/start/what-lands-where/"
  >}}
  {{< hextra/feature-card
    title="Honest boundaries"
    subtitle="A guard you wrongly believe in is worse than no guard. Every limit is written down where the feature is: what it reaches, what it cannot see, and what it does when it cannot run."
    link="guide/concepts/boundaries/"
  >}}
  {{< hextra/feature-card
    title="Containment on Linux"
    subtitle="`bounded-run` puts heavy work in a systemd scope with hard memory and CPU limits, and fails closed if its cgroup slice is missing. The limit is in the kernel, not in a prompt."
    link="guide/concepts/containment/"
  >}}
  {{< hextra/feature-card
    title="A gate with teeth"
    subtitle="An opt-in review lane where the merge is denied unless a review record matches the commit under review. Stale approval becomes mechanically impossible to merge past."
    link="guide/concepts/review/"
  >}}
  {{< hextra/feature-card
    title="Reference built from the tree"
    subtitle="Every table on this site is generated from the repository it documents. A unit added, removed or rewired changes the page in the same commit, or the build fails."
    link="reference/"
  >}}
{{< /hextra/feature-grid >}}
