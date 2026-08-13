---
title: Discipline that executes
layout: hextra-home
---

{{< hextra/hero-badge >}}

<div class="hx:w-2 hx:h-2 hx:rounded-none hx:bg-primary-400"></div>
  <span>Apache-2.0 · open source</span>
{{< /hextra/hero-badge >}}

<div class="hx:mt-6 hx:mb-6">
{{< hextra/hero-headline >}}
  Many agents.&nbsp;<br class="hx:sm:block hx:hidden" />One discipline.
{{< /hextra/hero-headline >}}
</div>

<div class="hx:mb-12">
{{< hextra/hero-subtitle >}}
  agentkit installs the same hooks, skills and rules into Claude Code,&nbsp;<br class="hx:sm:block hx:hidden" />
  Codex CLI, OpenCode and Grok CLI.
{{< /hextra/hero-subtitle >}}
</div>

<div class="hx:mb-6">
{{< hextra/hero-button text="Install it" link="guide/start/install/" >}}
</div>

<div class="hx:mt-12"></div>

{{< hextra/feature-grid >}}
{{< hextra/feature-card title="Refusal, not advice" link="guide/concepts/hooks/" subtitle="A force push, a `--no-verify`, an unbounded build — refused at the tool call, not warned about afterwards." >}}
{{< hextra/feature-card title="Install once, every agent" link="guide/start/what-lands-where/" subtitle="One copy under `~/.agentkit`, linked into each harness. Skills you installed yourself survive every upgrade." >}}
{{< hextra/feature-card title="Honest boundaries" link="guide/concepts/boundaries/" subtitle="Every limit states what it reaches, what it cannot see, and what it does when it cannot run." >}}
{{< hextra/feature-card title="Limits the kernel holds" link="guide/concepts/containment/" subtitle="`bounded-run` caps memory and CPU in a systemd scope, and fails closed if its slice is missing." >}}
{{< hextra/feature-card title="A gate with teeth" link="guide/concepts/review/" subtitle="The merge is denied unless a review record matches the exact commit under review." >}}
{{< hextra/feature-card title="Reference built from the tree" link="reference/" subtitle="Every table here is generated from the repository it documents, or the build fails." >}}
{{< /hextra/feature-grid >}}
