<!-- agentkit:resource-safety:start -->

# Resource-safe Execution

Never run resource-intensive developer commands directly on a shared or production-adjacent host.
Use `bounded-run` for dependency changes, compilers, typechecks, builds, linters, test suites,
browser automation, code generation, Cargo, Go, and pytest.

- Start unfamiliar tools and new toolchain versions with `bounded-run --profile canary -- ...`.
- Use `compile` for established compilers and builds, `browser` for Playwright, and `default` for
  established test suites.
- Pass direct argv after `--`; do not use `eval` or put credentials in command arguments.
- Treat timeout, OOM, high load, memory pressure, or a missing aggregate slice as a failed safety
  gate. Stop and diagnose within the existing boundary; never fall back to an unbounded command.
- Run only one heavy workload at a time. Verify host and service health before and after it.
- Never use `bounded-run` for delegated workloads such as `docker`, `podman`, `systemd-run`, remote
  execution, or container execution. The child work can escape its cgroup. Use a separately approved
  dedicated runner or verified native limits.
- Treat shell hooks and Codex prefix policies as defense-in-depth detection, not a hostile-code
  sandbox. Arbitrary scripts can deliberately delegate through APIs or sockets. The deterministic
  connectivity boundary combines `bounded-run` and its aggregate slice with
  host service resource limits that reserve capacity for the agent host and ingress path.
- Do not restart or reconfigure live services, Cloudflare tunnels, ingress, Kubernetes, networking,
  or remote access as part of a dependency or build workflow. Handle production infrastructure as a
  separately approved change with explicit rollback.

<!-- agentkit:resource-safety:end -->
