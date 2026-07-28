# Product Brief: agentkit

## Executive Summary

agentkit packages reusable skills, rules, plugins, hooks and tools for
multiple AI coding agents — OpenCode, Claude Code, Codex CLI and Grok CLI
[C-001] — under an Apache-2.0 license [C-002]. The product spans two
repositories: the kit itself, and a pages store that holds agent-published
web pages with git as the source of truth [C-009, C-010]. Its bet is that
agent behavior should be _enforced_, not described: rules like the consent
protocol ("never act and ask in the same turn") ship with police hooks
that enforce them [C-003, C-011].

## The Problem

An operator running several coding agents otherwise maintains the same
discipline several times, once per harness, and watches the copies drift.

## The Solution

One shared package, installed everywhere [C-001]. Fix a workflow once and
every agent inherits it; police hooks make skipping the discipline loud
instead of silent [C-011].

## What Makes This Different

Enforcement over prose [C-003, C-011], and a publishing surface whose serving
layer is disposable — the pages repository can re-seed it at any time
[C-010].

## Maturity, Honestly

No GitHub releases exist [C-004]; distribution is install-script based
[C-005], so consumers track a moving main with nothing to pin. Public
adoption signals are minimal [C-007, C-008]. The kit ships its own
measuring instrument: this brief was produced by agentkit's
product-intelligence skill [C-006].

## Not Verified

- The website surface (agentkit.sbs): the site lane's tools are not
  installed on the authoring host.
- macOS behavior: only Linux was exercised during acquisition.
- Adoption or install counts: no public telemetry exists.
