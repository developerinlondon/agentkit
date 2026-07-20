---
name: resource-safe-execution
description: >-
  Run resource-intensive developer commands inside deterministic systemd cgroup limits with
  bounded-run. Use for dependency installation or upgrades, compilers, typechecks, builds, test
  suites, linters, Playwright or browser work, code generation, Cargo, Go, and pytest, especially
  on shared or production-adjacent hosts where an unbounded process could
  disrupt Kubernetes, ingress, tunnels, or other services.
---

# Resource-safe Execution

Use `bounded-run` for every resource-intensive command. Never fall back to an unbounded command
when preflight or containment fails.

## Choose a profile

| Profile   | Workload                           | Memory high/max | CPU | Tasks | Time |
| --------- | ---------------------------------- | --------------- | --- | ----- | ---- |
| `canary`  | First execution of unknown code    | 1G / 2G         | 2   | 64    | 60s  |
| `default` | Established checks and test suites | 6G / 8G         | 2   | 256   | 10m  |
| `compile` | Compilers, typechecks, builds      | 8G / 12G        | 4   | 512   | 15m  |
| `browser` | Playwright and browser builds      | 12G / 16G       | 4   | 1024  | 20m  |

Start new compiler versions, dependency upgrades, unfamiliar generators, and incident
reproductions with `canary`. Increase only after the canary finishes cleanly.

## Run a command

Pass the executable and arguments after `--`. Do not pass a shell string.

```bash
bounded-run --profile canary -- bunx tsc --noEmit --singleThreaded
bounded-run --profile compile -- bun run typecheck
bounded-run --profile browser -- bunx playwright test
bounded-run --profile default -- cargo test
```

For a project-only AgentKit install, invoke `./.claude/tools/bounded-run`. The one-shot Claude
plugin bundles the runner and its denial message prints the resolved plugin-cache path. A global
install places `bounded-run` in `~/.local/bin`, with `agentkit-run` kept as a compat
symlink from the tool's previous name.

The runner preserves argv and the current directory, but exposes only a curated environment.
Retrieve credentials at runtime through the project's approved secrets mechanism; never put secrets
in argv.

## Apply the safety gate

1. Inspect host and service health without changing them.
2. Confirm the exact dependency or toolchain version and make the smallest reversible edit.
3. Run the first check with `canary`; observe exit status and host health.
4. Diagnose a timeout or OOM inside the existing limit. Do not raise limits reflexively.
5. Run the established profile repeatedly, then the remaining build and test gates.
6. Confirm no child processes remain and live services stayed healthy.

If `bounded-run` reports a missing or misconfigured `agent-work.slice`, insufficient headroom,
high load, or memory pressure, stop. Propose the required infrastructure correction and wait for
approval.

Hosts sized differently from the defaults pin their slice values in root-owned
`/etc/agentkit/resource-guard.conf` (`MEMORY_HIGH`, `MEMORY_MAX`, `MEMORY_SWAP_MAX`, `CPU_QUOTA`,
`TASKS_MAX`); the runner verifies the live slice against that file and falls back to its built-in
expectations when the file is absent.

## Judge by output markers, not exit status

`bounded-run` returns exit 0 even on a hard build failure, and a harness completion notice
repeats that exit code — so a run that never compiled anything reads as success. Judge every
build and test run by its own output markers (`test result:`, `N pass`, a compiler summary
line) and treat a missing summary line as failure, not as a silent pass.

Do not wrap `docker`, `podman`, or `systemd-run`. They can delegate work into a daemon, container,
or sibling service outside the transient cgroup. Use a separately approved dedicated runner or
verified engine-native limits for delegated workloads.

PreToolUse hooks and Codex prefix rules catch common accidental bypasses, but they are
defense-in-depth rather than a sandbox for hostile scripts. A script can deliberately contact a
daemon or user-systemd socket after launch. Preserve the host-level service limits and reserved
capacity that protect the agent host, ingress, and tunnels even if a child evades the workload
slice.

## Preserve connectivity

Do not restart, reconfigure, or replace live tunnels, ingress, Kubernetes, networking, or remote
access as part of a build or toolchain upgrade. Those are separate production changes requiring
their own approval, health checks, and rollback.
