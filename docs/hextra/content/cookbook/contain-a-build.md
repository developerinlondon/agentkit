---
title: Contain a heavy build
weight: 3
---

On Linux, heavy commands run inside a bounded systemd user service with fixed limits.
With `resource-police.enabled: true` in `~/.config/agentkit/config.yaml`, `resource-police`
refuses the unbounded form and names the bounded one; the `bounded` class list tunes which
command families that covers. By default the unit is off and `bounded-run` is simply available
as a tool.

```sh
bounded-run --profile compile -- cargo build --release
bounded-run --profile browser -- bunx playwright test
bounded-run --profile canary  -- ./unfamiliar-tool
bounded-run -- bun test                              # default profile
```

Everything after `--` is passed as argv, without shell evaluation. Only one `bounded-run` may run
at a time.

## Choosing a profile

| Profile   | Memory high/max | CPU  | Tasks | Command timeout | Use for                                  |
| --------- | --------------- | ---- | ----- | --------------- | ---------------------------------------- |
| `canary`  | 1G / 2G         | 200% | 64    | 60s             | unfamiliar tools, new toolchain versions |
| `default` | 6G / 8G         | 200% | 256   | 10m             | established test suites                  |
| `compile` | 8G / 12G        | 400% | 512   | 15m             | established compilers and builds         |
| `browser` | 12G / 16G       | 400% | 1024  | 20m             | Playwright and browser builds            |

## What it refuses, and why

**Delegated workloads.** The child work can escape the transient cgroup, so containing the parent
proves nothing:

```console
$ bounded-run -- docker build .
bounded-run: docker delegates work outside the service cgroup
```

The same applies to `podman`, `nerdctl`, `buildah`, `kubectl`, `systemctl`, `systemd-run`,
`machinectl`, `service`, `ssh`, `mosh`, `ansible` and `ansible-playbook`. Use a separately approved
dedicated runner or verified engine-native limits instead.

`resource-police` refuses these too, and names `AGENTKIT_ALLOW_DELEGATED=1` as the user-approved
override — but that override does not make `bounded-run` accept them. It only stops the police
blocking a _direct_ invocation you have decided to run yourself.

**A runner it does not recognise.** Anything can be named `bounded-run`, so the police trusts the
runner by its **installed path**, not by its name. `AGENTKIT_ALLOW_DELEGATED=1` does not clear this
one:

```text
BLOCKED: that is not a recognised bounded-run: … Anything can be named `bounded-run`, so it is
trusted by INSTALLED PATH, not by name — otherwise a spoof could silently neuter every limit.
```

In a fresh clone of agentkit itself, install the kit rather than running `./tools/bounded-run` in
place.

**Commands it cannot analyse.** Wrapper or shell nesting beyond the analysis depth bound is
refused rather than guessed at.

## Prerequisites, and how it fails

`bounded-run` **fails closed** unless all of these hold:

- cgroup v2 is available
- the aggregate `agent-work.slice` matches its expected limits — by default 20 GiB `MemoryHigh`,
  24 GiB `MemoryMax`, `MemorySwapMax=0`, 800% CPU, 1536 tasks
- host headroom checks pass

Hosts sized differently pin their values in root-owned `/etc/agentkit/resource-guard.conf`.

{{< callout type="warning" >}}
**Provision `agent-work.slice` on the host first**

`install.sh` provisions `agent-sessions.slice`, the per-session scope. The aggregate work slice
`bounded-run` verifies — `agent-work.slice` — is provisioned on the host separately. Until it
matches, `bounded-run` refuses to run: treat that as a safety gate to fix, not a reason to fall
back to the unbounded command.
{{< /callout >}}

Treat a timeout, an OOM, high load, memory pressure, or a missing slice the same way: stop and
diagnose inside the boundary.

## Off Linux

`bounded-run` is not installed on macOS or elsewhere, so cgroup containment stands down. The
delegation and undecidability analysis stays active: OpenCode always, and the Claude hook when
`jq`, `awk` and `cat` are present — without one of those it warns and intentionally fails open.
