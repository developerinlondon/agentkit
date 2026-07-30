---
title: FAQ
description: Answers to the things that actually go wrong, each traceable to the code that causes it.
sidebar:
  order: 5
---

## A guard refused something. Where is the reason?

In the refusal itself. Every `deny` carries a message that names what was blocked, what to do
instead, and — where a legitimate exception exists — the exact environment variable that clears it.
`pkg-police` refusing `npm ci` prints the bun mapping and
`Override (only when the user approves npm): prefix with AGENTKIT_ALLOW_PKG=1`. If a message reads
like a wall, it is because the fix is in it.

## How do I turn one guard off?

It depends on which one, and the difference matters.

| Want                                    | Do                                                            |
| --------------------------------------- | ------------------------------------------------------------- |
| skip one write-time check for a session | `AGENTKIT_SKIP_HOOKS=coding-police`                           |
| skip all three write-time checks        | `AGENTKIT_SKIP_HOOKS=all`                                     |
| get past a `PreToolUse` guard once      | prefix the one command with that guard's `AGENTKIT_ALLOW_*=1` |
| change a threshold permanently          | edit `~/.config/agentkit/config.yaml`                         |

`AGENTKIT_SKIP_HOOKS` is honoured by exactly four units: `coding-police`, `comment-police` and
`format-police` (the `PostToolUse` write hooks) and `version-police` (OpenCode). `version-police`
matches only its own name — `all` does not reach it. The `PreToolUse` guards ignore the variable
entirely; that is why each of them ships its own single-command override instead.

## Why did the formatter touch more than the file I edited?

`format-police` does not. It runs `dprint fmt` on exactly one path — the file from the tool payload —
using the nearest `dprint.json` found by walking up from that file's directory.

Whole-repository reformatting comes from running `dprint fmt` yourself with no arguments. This
repository's `dprint.json` sets `includes: ["**/*.md", "**/*.json", "**/*.toml", "**/*.yaml",
"**/*.yml"]`, so a bare invocation formats every matching file in the tree. Pass an explicit file
list. `tools/fix-ascii-boxes.py` has the same shape: with no arguments it globs `**/*.md` from the
current directory.

## Why did my edit get blocked by a `dprint` error in a different file?

It did not — that case is deliberately allowed through. `format-police` blocks (exit 2) only when
dprint's error text contains `Error formatting <the file you just edited>`. Everything else — an
unresolvable plugin, no network, a scoped `includes` that excludes the extension — is infrastructure
the model cannot act on, so the hook exits 0 with a warning on stderr.

A denylist was tried here and was unsound: dprint echoes the path into the message, so a pattern like
`*config*` silently swallowed real errors in any file under a `config/` directory.

## `format-police` printed a warning and did nothing. Why?

Two possibilities, both fail-open with a message on stderr:

- `dprint not found — skipping format`: no `dprint` on `PATH` and none under
  `~/.local/share/mise/installs/dprint`.
- `no dprint.json found`: nothing above the file's directory, up to `/` or `$HOME`, holds a
  `dprint.json`. Set `DPRINT_DEFAULT_CONFIG` to a config file for a global fallback.

## A guard went quiet. Is it broken?

Check for a missing dependency, and note that the two failure directions are chosen per guard:

| Guard             | Missing `jq` (or `awk`/`cat`)                                                    |
| ----------------- | -------------------------------------------------------------------------------- |
| `resource-police` | prints `DISABLED — missing …. Heavy commands are NOT being bounded.` and allows  |
| `review-police`   | **denies** the merge: it cannot check the record, so it does not let one through |
| `comment-police`  | exits 0 silently                                                                 |

The asymmetry is intentional. A detection guard that wedges every `Bash` call over a missing utility
gets deleted; a merge gate that permits when it cannot evaluate is worse than no gate.

## What does a second install run do?

Re-running the installer _is_ the upgrade — there is no version file or install manifest. What
persists across it:

- `~/.config/agentkit/config.yaml` is preserved untouched (a global install seeds it only when
  absent; a project install never writes it).
- The kit selection is remembered in `~/.agentkit/kits`, so a later bare
  `install.sh --global` upgrades the same set without re-passing `--with`.
- An **explicit** kit that is not selected has its previously installed hooks, tools, skills and
  prompt wiring **removed**.

See [Upgrading and removing](/docs/getting-started/upgrading/) for the per-file detail.

## Why is the review machinery not on by default?

Because two different things share the word "review", and only one of them blocks anything.

The advisory discipline — one non-authoring reviewer pass before merging substantive work — installs
with the `advisory-review` kit as `instructions/review-discipline.md`. Nothing enforces it, and it
is opt-in: an instruction is concatenated into every prompt, so a harness that already mandates a
reviewer pass would be carrying the rule twice.

The merge gate is the `adversarial-review` kit, and it is marked `explicit` in `skills/KITS`. That
means: never offered by the interactive picker, excluded from `--all`, installed only by a literal
`--with adversarial-review`. A gate that can refuse a merge is consent-gated, and a `y` at a prompt is too
easy to give without reading what it wires in. The corollary is that an install run without the kit
selected removes it again.

## Does agentkit need all four harnesses installed?

No. The default install does not probe for a client — it creates and populates each one's directories
unconditionally, so a harness you do not have ends up with an unused tree and nothing else happens.
Two places do check: the session shims symlink `claude`, `codex`, `opencode` and `grok` only for
runtimes actually found on `PATH` (printing `[shims] No supported agent runtimes found on PATH` when
there are none), and `--claude-plugin` warns and gives up if the `claude` CLI is missing.

One combination _is_ mutually exclusive: `--claude-plugin` installs the Claude bits as a plugin
**instead of** copying hooks and merging `settings.json`. Both at once would fire every hook twice,
so the installer refuses `--claude-plugin` without `--global` and does not mix the two modes.

## What do I lose on macOS?

`bounded-run` and `agent-session` both carry `# agentkit:platforms linux`, so the installer skips
them — and removes them if a previous Linux-era install left them behind. Consequently:

- Local containment stands down. There is no runner, so there is nothing to require.
- Session scoping stands down: the installer prints
  `[shims] Session scoping is Linux-only; skipping on darwin` and leaves `~/.bashrc` alone.
- `resource-police` keeps running. It still parses commands and still blocks delegated and
  undecidable ones — neither becomes safe because cgroups are unavailable — but it stops demanding
  the bounded form.
- Everything portable is unaffected: skills, rules, instructions, the other guards, `review-gate`,
  `review-profile`, `fix-ascii-boxes.py`.

## Why was `git checkout -b` refused in a repo I own?

`git-police` refuses creating a branch in a clone that has other worktrees, because another agent may
be working in it and a checkout swaps the tree under them. The message hands you the alternative:

```sh
git worktree add ../<repo>-wt/<name> -b <branch> origin/<default>
```

If you know nobody else is in that clone, prefix `AGENTKIT_ALLOW_SHARED_BRANCH=1`.

A second, separate refusal fires when you cut a branch while sitting on a feature branch — squash
merges make stacked branches conflict once the first one lands. That one is
`AGENTKIT_ALLOW_BRANCH_STACKING=1`.

## Why can I not open a second merge request?

`mr-police` blocks a new MR while you already have one open that you authored on that repo, so
unmerged MRs cannot stack up. The ceiling is `1` by default and is raised per command:
`AGENTKIT_MR_POLICE_MAX=2 glab mr create …`.

## Do repository-level config files work?

Only for the `review` section. `tools/review-profile` reads `<repo>/.agentkit/config.yaml` and merges
its `review:` keys over the global file. Every police hook and OpenCode plugin reads
`~/.config/agentkit/config.yaml` only — `coding-police` thresholds placed in a repo's
`.agentkit/config.yaml` are silently ignored.

The other `.agentkit/` files are not config: `review-policy.json` is the merge authority and is read
from the target commit, and `product.yaml` declares what the repo ships.

## `bounded-run` says the slice is not installed, or its limits are wrong.

`bounded-run` verifies `agent-work.slice` against exact expected values and refuses on any mismatch —
by default MemoryHigh 20G, MemoryMax 24G, MemorySwapMax 0, `CPUQuotaPerSecUSec` `8s`, TasksMax 1536.
A host sized differently pins its own numbers in root-owned `/etc/agentkit/resource-guard.conf`.

This is a failed safety gate, not a retry condition. Diagnose inside the boundary; do not fall back
to the unbounded command.

## Does the merge gate prove that a review happened?

No, and the tool says so in its own header. `review-gate` is a structural and semantic consistency
gate. The agent can write the local JSON, so the gate cannot prove reviewer identity, model-family
independence, that the recorded commands ran, that evidence was redacted, or that a referenced
evidence link says what the record claims. Required forge checks and approvals remain the authority
that stops a determined bypass.

What it _can_ prove is binding: the record's context must match the forge's exact source and target
SHAs and the digest of the policy file, so a record written for an earlier head does not satisfy the
gate.

## Is any of this a sandbox?

No. Hooks are guards: they detect and refuse at one tool call. They do not isolate a process,
contain hostile code, or survive an agent that runs the work some other way. `bounded-run` is the one
piece that changes what is _possible_ rather than what is permitted, and even that is a resource
boundary — cgroup limits — not a security boundary. It explicitly refuses container engines, direct
`systemd-run`, and remote execution because those delegate work outside the cgroup it controls.
