<div class="cover">
<div class="kicker">agentkit pages — publish integrity</div>
<h1>The page you publish. <span class="hi">The CSS you meant.</span></h1>
<p class="thesis">publish.ts now refuses to render with a theme upstream has replaced, and every remedy it prints has been executed and proven to work.</p>
<div class="stats">
  <div class="stat hot"><div class="num">2</div><div class="lbl">remedies that failed when run</div></div>
  <div class="stat"><div class="num">13</div><div class="lbl">review findings, all closed</div></div>
  <div class="stat"><div class="num">45s</div><div class="lbl">worst case vs an infinite hang</div></div>
  <div class="stat"><div class="num">0</div><div class="lbl">silent history loss paths left</div></div>
</div>
</div>

---

<div class="kicker">01 — the defect</div>

## Nothing failed, and that was the problem

<div class="callout alarm"><strong>Version skew inside one page.</strong> A pages clone two commits behind won the theme race silently: current markup rendered with superseded CSS, HTTP 200, plausible page. The drift warning then blamed the <em>bundle</em> — following its advice would have overwritten the good themes with the stale ones.</div>

<div class="chips"><span class="chip"><strong>found by</strong> publishing the v0.6.4 demo</span><span class="chip"><strong>issue</strong> #267</span><span class="chip"><strong>shipped</strong> c28cef9</span></div>

---

<div class="kicker">02 — the freshness gate</div>

## Refuse only what is provably stale

<div class="legend">
  <span class="key dim">mechanics</span>
  <span class="key red">refuses</span>
  <span class="key hot">publishes</span>
</div>

<ul class="rails">
  <li class="rail dim"><strong>Bounded fetch</strong> — 15s, terminal prompts off; a dead remote warns and carries on<span class="when">tolerated</span></li>
  <li class="rail dim"><strong>One question</strong> — <code>HEAD...@{u}</code> scoped to the <code>themes/</code> pathspec<span class="when">merge-base</span></li>
  <li class="rail red"><strong>themes/ moved upstream</strong> — name the stale side, print the remedy that works<span class="when">refuse</span></li>
  <li class="rail hot"><strong>Everything else</strong> — ahead-only, behind elsewhere, offline, no upstream<span class="when">publish</span></li>
</ul>

---

<div class="kicker">03 — the remedy contract</div>

## A printed remedy must work when executed

<div class="legend"><span class="key hot">works, proven by test</span><span class="key gold">conditional, cause left to git</span></div>

<ul class="rails">
  <li class="rail hot"><strong>Theme refusal</strong> — <code>git pull --rebase</code>, survives the divergence a stranded commit creates<span class="when">executed</span></li>
  <li class="rail hot"><strong>Rejected publish push</strong> — re-run pushes the stranded commit even with nothing newly staged<span class="when">executed</span></li>
  <li class="rail hot"><strong>Rejected delete push</strong> — retry survives the server's 404 and still records the deletion<span class="when">executed</span></li>
  <li class="rail gold"><strong>Push failure text</strong> — states what failed, shows git's error, offers rejection as one possibility<span class="when">no asserted cause</span></li>
</ul>

---

<div class="kicker">04 — why it stays fixed</div>

## The tests run the commands, not the regexes

<div class="cards cols-3">
  <div class="card"><span class="eyebrow">executed remedies</span><h3>World, not words</h3><p>Every printed command runs verbatim in a real bare-origin world; the test then asserts the clone ends level with canonical.</p></div>
  <div class="card"><span class="eyebrow">counterfactuals</span><h3>Red on the old code</h3><p>Each round's tests fail against the previous head — the fake server 404s like the production worker, which is what exposed the dead delete remedy.</p></div>
  <div class="card"><span class="eyebrow">bounded network</span><h3>Degrade, never stall</h3><p>Fetch 15s, push 30s, prompts off. A dead remote costs 45 seconds and a warning, not a hung publish after the page is already live.</p></div>
</div>

---

<div class="cover">
<div class="kicker">agentkit pages — publish integrity</div>
<h1>Loud where it matters. <span class="hi">Quiet where it works.</span></h1>
<p class="thesis">A current clone publishes silently; a stale one is refused with a remedy that has already been proven to work.</p>
</div>
