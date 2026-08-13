---
title: Discipline that executes
layout: hextra-home
---

{{< hextra/hero-badge >}}

<div class="hx:w-2 hx:h-2 hx:rounded-none hx:bg-primary-400"></div>
  <span>Claude Code · Codex CLI · OpenCode · Grok CLI</span>
{{< /hextra/hero-badge >}}

<div class="hx:mt-6 hx:mb-6">
{{< hextra/hero-headline >}}
  Standards your coding&nbsp;<br class="hx:sm:block hx:hidden" />agents cannot skip
{{< /hextra/hero-headline >}}
</div>

<div class="hx:mb-12">
{{< hextra/hero-subtitle >}}
  Written rules depend on an agent choosing to follow them. agentkit compiles yours&nbsp;<br class="hx:sm:block hx:hidden" />
  into hooks that refuse, gates that deny, and runners that cap — installed once,&nbsp;<br class="hx:sm:block hx:hidden" />
  enforced identically in every harness you use.
{{< /hextra/hero-subtitle >}}
</div>

<div class="hx:mb-6">
{{< hextra/hero-button text="Install it" link="guide/start/install/" >}}
</div>

<div class="hx:mt-12"></div>

{{< hextra/feature-grid >}}
{{< hextra/feature-card title="Refusal, not advice" link="guide/concepts/hooks/" subtitle="A force push, a `--no-verify`, an unbounded build — refused at the tool call, with the legitimate override named in the refusal." >}}
{{< hextra/feature-card title="Install once, every agent" link="guide/start/what-lands-where/" subtitle="One copy under `~/.agentkit`, linked into each harness. Skills you installed from anywhere else survive every upgrade untouched." >}}
{{< hextra/feature-card title="Honest boundaries" link="guide/concepts/boundaries/" subtitle="A guard you wrongly believe in is worse than none. Every limit states what it reaches, what it cannot see, and what it does when it cannot run." >}}
{{< hextra/feature-card title="Limits the kernel holds" link="guide/concepts/containment/" subtitle="`bounded-run` caps memory and CPU in a systemd scope and fails closed when its slice is missing, so the ceiling is not a suggestion." >}}
{{< hextra/feature-card title="A gate with teeth" link="guide/concepts/review/" subtitle="An opt-in lane that denies the merge unless a review record matches the exact commit under review. Stale approval cannot slip past." >}}
{{< hextra/feature-card title="Reference built from the tree" link="reference/" subtitle="Every table on this site is generated from the repository it documents. Add or rewire a unit and the page changes with it, or the build fails." >}}
{{< /hextra/feature-grid >}}
