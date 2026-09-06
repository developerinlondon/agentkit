---
title: CLI and tools
weight: 3
---

Seven executables ship in `tools/`. Two of them are Linux-only and the installer omits them
elsewhere; two of them only arrive with the explicit `adversarial-review` kit.

| Tool                 | Platform   | Ships with                  |
| -------------------- | ---------- | --------------------------- |
| `bounded-run`        | Linux only | every install               |
| `agent-session`      | Linux only | every install               |
| `wip`                | portable   | every install               |
| `plan-gate`          | portable   | every install               |
| `fix-ascii-boxes.py` | portable   | every install               |
| `review-gate`        | portable   | `--with adversarial-review` |
| `review-profile`     | portable   | `--with adversarial-review` |

Platform support is metadata, not installer knowledge: `bounded-run` and `agent-session` carry an
`# agentkit:platforms linux` directive in their first 15 lines, and `install_tools` skips — or
**removes** — any tool whose directive excludes the detected platform. Same mechanism removes
`review-gate` and `review-profile` when `adversarial-review` is not selected.

Global installs put executables in `~/.local/bin/` and mirror them under `~/.agentkit/tools/`.
Project installs expose them at `<project>/.claude/tools/`. `agentkit-run` remains as a symlink to
`bounded-run` from the tool's previous name.

The Claude plugins carry their own copies, from an explicit allowlist in
`scripts/sync-cc-plugin.sh`: the core `agentkit` plugin gets `bounded-run`, `wip` and
`plan-gate`, and
`review-gate`/`review-profile` go to `agentkit-adversarial-review` instead. `resource-police` accepts
`$CLAUDE_PLUGIN_ROOT/tools/bounded-run` as a trusted runner and names that path when it denies an
unbounded command — the runner is trusted by installed path, never by filename.

## `bounded-run`

```
bounded-run [--profile canary|default|compile|browser] -- COMMAND [ARG...]
```

Runs one resource-intensive command in a transient systemd user service inside
`agent-work.slice`. The command is passed as argv and never shell-evaluated. Only one `bounded-run`
may hold the lock at a time.

| Profile   | MemoryHigh / MemoryMax | CPUQuota | TasksMax | Command timeout | RuntimeMaxSec |
| --------- | ---------------------- | -------- | -------- | --------------- | ------------- |
| `canary`  | 1G / 2G                | 200%     | 64       | 60s             | 75s           |
| `default` | 6G / 8G                | 200%     | 256      | 10m             | 10m15s        |
| `compile` | 8G / 12G               | 400%     | 512      | 15m             | 15m15s        |
| `browser` | 12G / 16G              | 400%     | 1024     | 20m             | 20m15s        |

`default` is the profile when `--profile` is omitted. Every profile also sets
`MemorySwapMax=0`, `OOMPolicy=kill`, `KillMode=control-group`, `NoNewPrivileges=yes`,
`RestrictSUIDSGID=yes`, `KeyringMode=private`, `UMask=0077` and `Nice=10`.

### Preflight, all of it fail-closed

Before the command runs, `bounded-run` verifies:

1. Ten control binaries exist, are executable, are root-owned, and are not group- or
   world-writable — `awk`, `env`, `flock`, `getconf`, `id`, `realpath`, `stat`, `systemctl`,
   `systemd-run`, `timeout`.
2. cgroup v2 is available (`/sys/fs/cgroup/cgroup.controllers` is readable).
3. The user systemd manager is reachable on the session bus.
4. `agent-work.slice` is loaded **and matches its expected limits exactly** — by default
   MemoryHigh 20G, MemoryMax 24G, MemorySwapMax 0, `CPUQuotaPerSecUSec` of `8s` (i.e. 800%), and
   TasksMax 1536. A host sized
   differently pins its own values in root-owned `/etc/agentkit/resource-guard.conf`; an unknown key
   or malformed line in that file aborts the run.
5. Host headroom: available memory covers the profile's `MemoryMax` **plus** 25% of total RAM;
   one-minute load is at most 2× CPU count; memory pressure `avg10` is at most `some=10`,
   `full=2`.

Any of these failing is a failed safety gate, not a reason to retry unbounded.

### What it refuses to run

| Refused                                                                                                                                                | Why                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| a nested `bounded-run` / `agentkit-run`                                                                                                                | already bounded                           |
| `doas`, `env`, `pkexec`, `run0`, `su`, `sudo`                                                                                                          | privilege change                          |
| `ansible`, `ansible-playbook`, `buildah`, `docker`, `kubectl`, `machinectl`, `mosh`, `nerdctl`, `podman`, `service`, `ssh`, `systemctl`, `systemd-run` | delegates work outside the service cgroup |
| `sh -c`, `bash --command=…` and friends                                                                                                                | shell command strings; pass direct argv   |

The basename is checked before **and** after `realpath` resolution, so a symlink to `docker` is
still refused.

### Environment

The child gets `env -i` plus an allowlist: `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `TERM`,
`COLORTERM`, `LANG`, `LANGUAGE`, `LC_ALL`, `TZ`, the three `XDG_*` dirs, `BUN_INSTALL`,
`CARGO_HOME`, `RUSTUP_HOME`, `GOCACHE`, `GOMODCACHE`, `GOPATH`, `GOMEMLIMIT`, `GOMAXPROCS`,
`NODE_OPTIONS`, `PLAYWRIGHT_BROWSERS_PATH`, `CI`, `NO_COLOR`, `FORCE_COLOR`, `SSH_AUTH_SOCK`, and
`AGENTKIT_RUN_ACTIVE=1`. Anything not on that list is gone inside the service.

### Exit codes

| Code          | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `64`          | usage error, or a refused command shape                             |
| `69`          | preflight failed (control plane, slice, headroom, missing bus)      |
| `75`          | another `bounded-run` holds the lock (`flock --conflict-exit-code`) |
| anything else | the command's own status                                            |

{{< callout type="info" >}}
**Read the stderr, not only the status**

Failures are reported on stderr prefixed `bounded-run:`, which is where the reason for a refusal or
a preflight failure appears.
{{< /callout >}}

## `agent-session`

Runs one interactive agent CLI inside its own systemd **scope** in `agent-sessions.slice`, so one
session cannot exhaust a budget shared with its siblings. Two forms:

```sh
agent-session claude [args...]     # explicit
~/.local/share/agentkit/shims/claude [args...]   # via the installed shim symlink
```

A global Linux install symlinks `claude`, `codex`, `opencode` and `grok` in
`${XDG_DATA_HOME:-~/.local/share}/agentkit/shims` to `agent-session` — only for runtimes actually
found on `PATH` — and forces that directory to the front of `PATH` in `~/.bashrc` and in the login
profile bash reads (`~/.bash_profile`, `~/.bash_login` or `~/.profile`), so IDE terminals, which are
login shells that prepend `~/.local/bin` last, still resolve to the shim. `--no-session-scope` skips
both. The installer also writes the `agent-sessions.slice` unit (CPUQuota 1600%, MemoryHigh 24G,
MemoryMax 32G, MemorySwapMax 4G, TasksMax 24576); operator overrides belong in an
`agent-sessions.slice.d/` drop-in, which a re-install will not clobber.

`--scope` keeps the process in the caller's TTY, session and process group, so an interactive TUI
keeps job control and signal delivery. Only the cgroup changes.

| Default           | Value | Override                           |
| ----------------- | ----- | ---------------------------------- |
| `TASKS_MAX`       | 4096  | `/etc/agentkit/session-guard.conf` |
| `MEMORY_HIGH`     | 12G   | same                               |
| `MEMORY_MAX`      | 16G   | same                               |
| `MEMORY_SWAP_MAX` | 2G    | same                               |

The limits file must be owned by root or by the invoking user; a third party's file is ignored with
a warning. An invalid value keeps the built-in default and warns; an unknown key is ignored, never
fatal. `AGENTKIT_SESSION_CONF` relocates the file. It is deliberately **not**
`/etc/agentkit/resource-guard.conf`, which `bounded-run` parses strictly and dies on.

{{< callout type="info" >}}
**Fail-open by contract**

Unlike `bounded-run`, `agent-session` never blocks a session from starting. If `systemd-run` is
missing, the user bus is unreachable, or a scope already wraps this process
(`AGENTKIT_SESSION_SCOPE` is set), it `exec`s the real runtime unscoped.
{{< /callout >}}

Exit codes: `64` when invoked as `agent-session` with no command, `69` when the target cannot be
found on `PATH` outside the shim directory. Otherwise it `exec`s and the runtime owns the status.

{{< callout type="info" >}}
**`agent-session` takes a command, not flags**

It is the one tool here with no `--help`. Its first argument is the command to run, so
`agent-session --help` tries to resolve `--help` on `PATH` and exits `69` with
`cannot find '--help' on PATH outside the shim directory`.
{{< /callout >}}

## `wip`

Read-only. Reports what was started and not finished, for one repository or several. It blocks
nothing, changes nothing, and exits `0` unless an argument is unusable.

```
wip [--limit N] [--no-forge] [REPO...]
```

| Row         | Means                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| `BRANCH`    | an open change, or none ever opened, or state unknown                        |
| `ABANDONED` | a change closed without merging — a decision, not an oversight               |
| `WORKTREE`  | a checkout that still exists; `DIRTY` ones hold work no branch ref will save |
| `MR/PR`     | open and authored by you, with what stands between it and merging            |
| `FILED`     | issues you opened that are still open                                        |
| `DEFERRED`  | filed issues whose text says they were carved out of other work              |
| `PLAN`      | a plan whose gaps section lists work neither closed nor tracked              |
| `MERGED`    | merged on the forge — cleanup, not unfinished work                           |
| `COUNTS`    | the other kinds of outstanding thing, broken out rather than summed          |
| `NOTE`      | something that was **not** checked or was hidden, and why                    |

### What the headline counts, and what is hidden

The headline is **unfinished branches only**. Branches, worktrees, issues and plan gaps are four
different kinds of thing with four different remedies, so summing them into one number gives a
figure nobody can act on. The rest are broken out on the `COUNTS` line.

A branch is hidden when **nothing was committed, no worktree is checked out on it, and no change
was ever opened**. Nothing was started, so there is nothing to finish. On one real repository that
removed 20 of 41 branches — all created by a worktree harness — and took the headline from a
meaningless 150 to an actionable 4.

The test is structural, never by name. A `worktree-agent-*` pattern would look tidier and is worse:
it would hide such a branch that _does_ carry commits, which is real unfinished work. Having commits
disqualifies a branch from being hidden, so this rule cannot make that mistake. Nor can it hide the
case that matters most — a branch with no commits but a **dirty worktree**, where uncommitted work
actually lives; the worktree keeps it visible.

Whatever is hidden is counted and stated in a `NOTE`. Silent omission reads as "nothing else to see".

### Branch state comes from the forge

Whether a branch is finished is answered by the forge, never by git topology. A squash merge
destroys the topological evidence by design: the squashed commit is not an ancestor of the branch,
and the merge base stays before the squash forever.

Measured against nine branches of known outcome, every git-only rule reported all seven merged ones
as still outstanding:

| Rule                                    | On a squash-merged branch                                       |
| --------------------------------------- | --------------------------------------------------------------- |
| `rev-list --count base..head`           | ahead forever — the squash is not an ancestor                   |
| `git diff base..head`                   | shows the default branch's own later commits as deletions       |
| `git diff base...head`                  | shows the branch's changes since the merge base — never empty   |
| `merge-tree --write-tree`, tree compare | correct on a small fixture, wrong once the default branch moves |

The last of those is the trap worth naming: it passes a two-commit fixture and fails on a real
repository, because a fixture whose default branch has not moved cannot distinguish the case it
exists to prove.

`wip` asks the forge for every change whose source branch matches, normalises the state to
merged / open / closed, and queries by name for any branch older than the bulk listing window.
One merged change outranks a closed one on the same branch.

### When the forge cannot answer

There is no local rule to fall back to, so `wip` reports that it does not know:

```
BRANCH    feat/thing    12d   3 commits  state UNKNOWN — forge could not be asked
NOTE      branch state is DEGRADED: only the forge can tell a squash-merged branch
          from an unfinished one, so no branch above is known to be outstanding
```

An absent section means "nothing found"; a `NOTE` means "not looked at". A bounded list always says
how many entries it dropped. `--limit 0` removes the bound; `--no-forge` skips the network entirely
and degrades the same way.

### Forges

GitHub and GitLab both work, resolved per repository from its `origin` host — including self-hosted,
via `gh auth status --hostname` and the GitLab version endpoint. Note that the two disagree on
spelling: GitHub reports `OPEN`, GitLab reports `opened`; `merged` and `closed` coincide.

### Exit codes

| Code | Meaning                                           |
| ---- | ------------------------------------------------- |
| `0`  | reported, whatever it found                       |
| `2`  | an argument is not a git repository, or bad usage |

## `plan-gate`

Judges whether a plan may be treated as done, by parsing its own gaps section. This is the single
parser for that section: `wip` calls it to report, and `plan-police` calls it to refuse an edit that
declares a plan done while a gap stands. A second scanner would eventually disagree with this one.

```
plan-gate [options] [PLAN...]

  --repo DIR         repository root to discover plans in (default: cwd)
  --stdin NAME       read one plan's content from stdin; NAME is the path to report
  --matches PATH     exit 0 if PATH would be judged as a plan, 1 if not
  --require-done     only report blocking gaps for plans that mark themselves done
  --all              also list gaps that are closed or tracked
  --tsv              machine output: STATUS<TAB>PLAN<TAB>LINE<TAB>TEXT
  --quiet            no output; exit status only
  --list-plans       print the plan files that would be judged, then exit
```

A gap is one list item under a gaps heading. It stops blocking when the author does one of two
things they would do anyway:

- **ticks it** — `- [x] …`, or strikes it through (`- ~~no longer applies~~`)
- **names the issue that carries it** — `#123`, `!123`, `GH-123`, or an issue/MR/PR URL, on the
  gap's own line or a sub-bullet under it

The referenced issue's _state_ is deliberately not checked. That keeps the gate offline and
deterministic; `wip` reports open authored issues separately.

`--matches` is the single source of what counts as a plan. `plan-police` asks rather than matching
for itself, so the hook and the gate cannot drift apart — and a path is compared physically, since
a symlink above the repository (macOS reaches every temporary directory through `/var` →
`/private/var`) would otherwise make a plan stop looking like one, silently.

### Exit codes

Both the hook and CI branch on these, so they are part of the contract.

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `0`  | nothing blocking — no open gap, or the plan does not claim done |
| `1`  | at least one gap is neither closed nor tracked                  |
| `2`  | usage error                                                     |
| `3`  | fault — a named plan is missing or unreadable                   |

Discovery and matching are configurable per repository; see
[Configuration](/reference/configuration/).

## `review-gate`

Ships only with `--with adversarial-review`. Validates a strict review record against a trusted policy.

```
review-gate --record FILE --policy FILE --changed-paths FILE
  --forge github|gitlab --repository URL --repository-id ID --change-id N
  --source-branch NAME --target-branch NAME
  --source-sha SHA --target-sha SHA
```

All eleven flags are required; `jq` and `git` must be on `PATH`. It checks, in order:

1. The policy is valid JSON and conforms to `schema_version: 1` — including that the `critical`
   tier cannot allow unverified claims, cannot allow local consent, must require a product review,
   verified claims, an evidence ref, at least one check, and all seven analysis kinds.
2. The changed-path list is a non-empty array of unique non-blank strings.
3. The record conforms to `schema_version: 2`.
4. `.context` matches the passed forge change context **exactly**, including a `policy_digest` equal
   to `git hash-object --no-filters` of the policy file.
5. The record's declared risk tier is at least the minimum derived from the policy's path-regex risk
   zones — and a change touching `.agentkit/review-policy.json` is always `critical`.
6. Every declared check exists in the policy with an identical command; every required check and
   analysis for the tier is present and satisfied; product coverage is allowed for the tier.
7. The verdict it derives from the evidence equals the verdict the record stores.

| Outcome                   | Exit | stdout/stderr                 |
| ------------------------- | ---- | ----------------------------- |
| valid pass                | `0`  | `PASS: …`                     |
| blocked, consent accepted | `0`  | `CONSENT_OVERRIDE: …`         |
| any refusal               | `1`  | `BLOCKED: <reason>` on stderr |
| bad or missing flags      | `2`  | usage on stderr               |

Blocking severities default to `["BLOCKER","HIGH"]` and are configurable via
`gate.blocking_severities` in the target policy. `user_consent` must be **absent** from a passing
record, and is refused outright on a tier whose policy sets `allow_local_consent: false`.

{{< callout type="info" >}}
**A consistency gate, not an authentication one**

The file header says so in its first three lines: `review-gate` checks structural and semantic
consistency. Reviewer identity, independence, command execution, redaction and the truth of any
referenced evidence are owned by forge protections.
{{< /callout >}}

## `review-profile`

Ships only with `--with adversarial-review`. Resolves how much review effort one task gets, and emits
JSON. It decides nothing about merges.

```
review-profile [--profile fast|balanced|strict] [--risk trivial|standard|critical]
               [--release] [--user-facing] [--repo PATH]
```

Requires `jq`. Output is a single-line JSON object with `schema_version: 1`, the resolved
`profile`, a `context` block (risk, release, user_facing, `target_policy_authoritative: true`,
`worktree_policy_present`), a `settings` block of the seven resolved keys plus
`min_reported_severity`, and a `required` block of booleans.

How the booleans are derived:

| Required            | True when                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `primary_review`    | `primary-review: always`, or risk is not `trivial`                                                            |
| `specialist_review` | `specialist-review: always`, or `critical` and risk is `critical`                                             |
| `product_review`    | `always`; or `release` with `--release`; or `triggered` with risk `critical`, `--release`, or `--user-facing` |
| `rerun_ci`          | `ci-evidence: rerun`                                                                                          |
| `full_local_checks` | `local-checks: full`                                                                                          |
| `evidence_note`     | `evidence-note: always`, or risk is `critical`                                                                |

`worktree_policy_present` reports whether `<repo>/.agentkit/review-policy.json` exists in the
worktree. That is informational — the gate reads the policy from the target commit, not the
worktree.

Every run appends one tab-separated line to `${HOME:-/tmp}/.agentkit/review-audit.log`. The append
is best-effort and never fails the run. Config errors exit `2`; see
[Configuration](/reference/configuration/) for the keys and precedence.

## `fix-ascii-boxes.py`

Aligns the right-hand `│` of ASCII boxes inside markdown code fences. Nested boxes are sorted by
enclosure depth and the innermost is fixed first, then outward.

Two conditions narrow what it touches, both stricter than they look:

- **Bare fences only.** A line counts as a fence delimiter when it is exactly `` ``` `` after
  stripping. A language-tagged opener like `` ```text `` is not recognised as a fence at all.
- **The first non-empty line of the block must both start with `┌` at column 0 and end with `┐`.**
  Anything else — an indented box, a tree diagram, a box whose top border is not the first line —
  makes the whole block skipped.

It has no `--help`; `--check` is its only flag.

```sh
python3 tools/fix-ascii-boxes.py path/to/file.md   # fix specific files
python3 tools/fix-ascii-boxes.py --check           # validate only
python3 tools/fix-ascii-boxes.py                   # every .md under the cwd
```

Exit `0` prints `PASS: All ASCII boxes aligned`; exit `1` prints `FAIL:` and lists every misaligned
line, marking `UNFIXABLE` ones. A missing file is a warning on stderr, not a failure.

{{< callout type="warning" >}}
**Pass an explicit file list**

With no file arguments it globs `**/*.md` recursively from the current directory and rewrites every
file it can.
{{< /callout >}}

## Environment variables

### Per-command guard overrides

Every one of these is read from the hook's environment **and** matched as an inline prefix in the
command text, because a prefix assignment never reaches the hook's own environment. Prefix them onto
one command; they are deliberately not config.

| Variable                           | Clears                                                                                                                                                                                        | Read by                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `AGENTKIT_ALLOW_PKG=1`             | `pkg-police` — npm/npx/yarn/pnpm                                                                                                                                                              | `hooks/claude/pkg-police.sh`, `plugins/pkg-police.ts`           |
| `AGENTKIT_ALLOW_DELEGATED=1`       | `resource-police` — delegated workloads                                                                                                                                                       | `hooks/claude/resource-police.sh`, `plugins/resource-police.ts` |
| `AGENTKIT_ALLOW_STALE_PUSH=1`      | `git-police` — branch behind the default branch                                                                                                                                               | `hooks/claude/git-police.sh`                                    |
| `AGENTKIT_ALLOW_BRANCH_STACKING=1` | `git-police` — new branch cut from a feature branch                                                                                                                                           | `hooks/claude/git-police.sh`                                    |
| `AGENTKIT_ALLOW_SHARED_BRANCH=1`   | `git-police` — new branch in a clone with other worktrees                                                                                                                                     | `hooks/claude/git-police.sh`                                    |
| `AGENTKIT_ALLOW_BARE_SVG=1`        | `pages-police` — `--allow-bare-svg` figure lint                                                                                                                                               | `hooks/claude/pages-police.sh`                                  |
| `AGENTKIT_MR_POLICE_MAX=<n>`       | `mr-police` — raises the open-MR ceiling (default `1`)                                                                                                                                        | `hooks/claude/mr-police.sh`                                     |
| `AGENTKIT_BRANCH_WIP_MAX=<n>`      | `git-police` — raises the unfinished-branch ceiling (default `1`); exactly `off` disables the cap, and any other unusable value warns and falls back to `1` rather than disabling it silently | `hooks/claude/git-police.sh`                                    |

`AGENTKIT_ALLOW_DELEGATED=1` does **not** clear the unrecognised-runner refusal:
`resource-police` trusts `bounded-run` by installed path, never by name.

### Session and task scope

| Variable                  | Effect                                                        | Read by                                                      |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `AGENTKIT_SKIP_HOOKS`     | comma-separated hook names to disable for the session         | see below                                                    |
| `AGENTKIT_REVIEW_PROFILE` | overrides the resolved review `profile`                       | `tools/review-profile`                                       |
| `AGENTKIT_PLATFORM`       | forces `linux`/`darwin`/`unknown` instead of `uname -s`       | `lib/install-platform.sh`, `hooks/claude/resource-police.sh` |
| `AGENTKIT_SESSION_CONF`   | path to the session limits file                               | `tools/agent-session`                                        |
| `AGENTKIT_SESSION_SCOPE`  | set by `agent-session`; its presence prevents nesting a scope | `tools/agent-session`                                        |
| `AGENTKIT_RUN_ACTIVE`     | set to `1` in the bounded child; its presence refuses nesting | `tools/bounded-run`                                          |
| `AGENTKIT_HOOK_TARGET`    | `codex` makes the supervisor emit `block` instead of `deny`   | `hooks/claude/fail-closed-hook.sh`                           |

`AGENTKIT_SKIP_HOOKS` has narrower reach than it looks:

| Unit             | Honours it | Honours `all`                      |
| ---------------- | ---------- | ---------------------------------- |
| `coding-police`  | yes        | yes                                |
| `comment-police` | yes        | yes                                |
| `prose-police`   | yes        | yes                                |
| `format-police`  | yes        | yes                                |
| `plan-police`    | yes        | yes                                |
| `wait-police`    | yes        | yes                                |
| `version-police` | yes        | **no** — matches its own name only |
| `issue-police`   | yes        | yes                                |
| everything else  | **no**     | —                                  |

Four of those are the `PostToolUse` write hooks, `plan-police` guards a plan edit, `wait-police`
runs on `Stop`, `version-police` is an OpenCode plugin, and `issue-police` is the one blocking
`PreToolUse` exception. The other `PreToolUse` guards — `git-police`, `pkg-police`,
`resource-police`, `kubectl-police`, `mr-police`, `pages-police`, `review-police` — ignore
`AGENTKIT_SKIP_HOOKS` entirely. Values are
whitespace-stripped, so `a, b` behaves like `a,b`.

### Installer and bootstrap

| Variable               | Default                                                                                      | Read by        |
| ---------------------- | -------------------------------------------------------------------------------------------- | -------------- |
| `AGENTKIT_HOME`        | `~/.agentkit`                                                                                | `install.sh`   |
| `AGENTKIT_SKIP_PROMPT` | unset — any **non-empty** value suppresses the kit question (a non-empty `CI` does the same) | `install.sh`   |
| `AGENTKIT_SRC`         | `~/.agentkit-src`                                                                            | `bootstrap.sh` |
| `AGENTKIT_REPO_URL`    | `https://github.com/developerinlondon/agentkit.git`                                          | `bootstrap.sh` |
| `AGENTKIT_REF`         | unset — the newest `vX.Y.Z` tag. Takes a tag or a branch; `main` is the unreleased edge      | `bootstrap.sh` |

### Skill-specific

| Variable                             | Default                                                                                                                                                                                                                | Read by                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `AGENTKIT_PAGES_ENDPOINT`            | `https://account.agentkit.sbs`                                                                                                                                                                                         | `skills/publish-page/publish.ts`                                |
| `AGENTKIT_SITE_ENDPOINT`             | `https://agentkit.sbs`                                                                                                                                                                                                 | `pages/site/deploy.sh`, `docs/site/deploy.sh`                   |
| `AGENTKIT_PAGES_REPO`                | first of `~/code/agentkit-pages`, `~/code/agentkit/agentkit-pages` that contains a `.git`                                                                                                                              | `skills/publish-page/publish.ts`                                |
| `AGENTKIT_CHROMIUM`                  | first existing of `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`, `/opt/google/chrome/chrome`, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; then Playwright's own cache | `skills/diagram/render.ts`                                      |
| `AGENTKIT_DIAGRAM_VENDOR_ICONS`      | `~/.agentkit/diagram/vendor-icons`                                                                                                                                                                                     | `skills/diagram/scripts/vendor-packs.ts`                        |
| `AGENTKIT_DIAGRAM_VENDOR_PACKS`      | `skills/diagram/assets/vendor-packs.json`                                                                                                                                                                              | `skills/diagram/scripts/vendor-packs.ts`                        |
| `AGENTKIT_DIAGRAM_ALLOW_LOCAL_PACKS` | unset — `1` permits a local `file:` archive                                                                                                                                                                            | `skills/diagram/scripts/fetch-icons.ts`                         |
| `AGENTKIT_REF`, `AGENTKIT_REPO`      | `main`, the GitHub URL                                                                                                                                                                                                 | the CI templates under `skills/product-intelligence/assets/ci/` |

`AGENTKIT_RAW_INPUT` appears in `hooks/claude/lib/hook-input.sh` but is not a knob — it holds the
slurped hook payload. `AGENTKIT_BASH32`, `AGENTKIT_MUTATE`, `AGENTKIT_RUN_TESTING`,
`AGENTKIT_RUN_PROC_ROOT`, `AGENTKIT_RUN_INTEGRATION`, `AGENTKIT_TEST_PTY_DRIVER` and
`AGENTKIT_DIAGRAM_TEST_LIMITS` are read only by the test suite. `AGENTKIT_SITE_URL`,
`AGENTKIT_SITE_TOKEN_FILE` and `AGENTKIT_ALLOW_DIRTY_DEPLOY` belong to `docs/site/deploy.sh`, which
publishes this documentation site and is not part of an install.
