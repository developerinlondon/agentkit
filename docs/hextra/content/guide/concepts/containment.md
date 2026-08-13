---
title: Containment
weight: 5
---

A hook can refuse an unbounded build. It cannot make a bounded one _stay_ bounded. That is the
difference between the hook surface and the tool surface: `bounded-run` does not ask a build to be
polite, it makes exceeding the cgroup impossible.

Linux only. It needs systemd user scopes and cgroup v2, and it declares that in its own header
(`# agentkit:platforms linux`), so the installer removes it from hosts that cannot honour it.

## Running something under it

```sh
bounded-run [--profile canary|default|compile|browser] -- COMMAND [ARG...]
```

The command is passed as **argv without shell evaluation**, and only one `bounded-run` may run at a
time — a lock, not a queue, so a second one fails rather than piling load on the first.

```sh
bounded-run --profile compile -- cargo build --release
bounded-run -- bun test
```

## Profiles

Fixed and tested together with the host configuration, rather than tunable per invocation:

| Profile   | Memory high/max | CPU quota | Tasks | Command timeout |
| --------- | --------------- | --------- | ----- | --------------- |
| `canary`  | 1G / 2G         | 200%      | 64    | 60s             |
| `default` | 6G / 8G         | 200%      | 256   | 10m             |
| `compile` | 8G / 12G        | 400%      | 512   | 15m             |
| `browser` | 12G / 16G       | 400%      | 1024  | 20m             |

`memory.high` throttles; `memory.max` kills. The pair is deliberate: a build that briefly overshoots
is slowed rather than destroyed, and one that runs away is stopped.

## It fails closed

Before it runs anything, `bounded-run` verifies the host is actually configured to contain it:

{{% steps %}}

### cgroup v2 is available

`/sys/fs/cgroup/cgroup.controllers` must exist.

### The aggregate slice exists and matches

`agent-work.slice` must be present with its expected limits — by default 20G/24G memory high/max,
800% CPU and 1536 tasks. Hosts sized differently pin their own values in root-owned
`/etc/agentkit/resource-guard.conf`.

### Host headroom passes

Free memory is checked against the profile's ceiling, so a bounded command cannot be the thing that
takes the host down.

{{% /steps %}}

If any of those fails, it exits non-zero and runs nothing — `69` (`EX_UNAVAILABLE`) for an
environment it cannot trust, `64` (`EX_USAGE`) for a malformed invocation.

{{< callout type="warning" >}}
**The work slice is host-provisioned; the installer does not create it.** `install.sh` provisions
the _session_ slice, `agent-sessions.slice`. `agent-work.slice` is a separate host concern, and
`bounded-run` refuses until it is in place. Two slices, two owners.
{{< /callout >}}

## Trust is by path, not by name

Anything can be called `bounded-run`. `resource-police` therefore recognises the runner by its
**installed path**, not its filename — otherwise a shell function or a local script of the same name
could silently neuter every limit while the refusal message congratulated it.

`AGENTKIT_ALLOW_DELEGATED=1` does not clear that particular refusal.

## What it deliberately does not contain

Child work that leaves the transient scope is not contained, so these are excluded by design rather
than wrapped and hoped for:

| Excluded           | Why                                            |
| ------------------ | ---------------------------------------------- |
| `docker`, `podman` | the daemon runs the workload in its own cgroup |
| `systemd-run`      | it creates a new unit outside this one         |
| `ssh`              | the work happens on another host               |

Use the engine's own limits there — `docker run --memory`, a remote host's own slice. Pretending to
contain them would be the more dangerous outcome, because you would stop watching.

## Which commands the guard requires it for

With `resource-police` enabled, these classes must go through the installed runner:

| Class         | Covers                                                      |
| ------------- | ----------------------------------------------------------- |
| `js-packages` | bun/npm/pnpm/yarn dependency changes (add, install, update) |
| `js-scripts`  | package-script builds, checks, lints, test suites           |
| `typescript`  | `tsc`, direct or via `bunx`/`npx`                           |
| `playwright`  | `playwright test`                                           |
| `cargo`       | `cargo build`/`check`/`test`/`clippy`                       |
| `go`          | `go build`/`test`                                           |
| `moon`        | `moon ci`/`check`/`run`                                     |
| `python`      | `pytest`, `pip`/`uv` installs                               |

Remove entries from `resource-police.bounded` to relax individual classes; omitting the list bounds
every class. The unit is **off by default** — see
[configuration](/reference/configuration/#resource-police).

{{< callout type="info" >}}
Bounding matches command prefixes, so privileged or remote wrappers (`sudo`, `ssh`) around a heavy
command are only caught when `delegation-police` is enabled too.
{{< /callout >}}
