---
title: Glossary
weight: 6
---

Definitions as the code means them, not as the words are used generally.

## Surface

One of the four places agentkit installs behaviour: skills, rules and instructions, hooks and
policies, tools. The four are ordered by a trade: what reaches everywhere can only advise, and what
cannot be skipped acts at exactly one point. Four surfaces, four clients — unrelated counts.

## Harness

An agent CLI that agentkit installs into. `install.sh` targets four: OpenCode, Claude Code, Codex
CLI and Grok CLI. Each has its own extension mechanism, which is why one police unit has up to three
implementations.

## Adapter

The per-client wiring that binds one canonical tree to one harness. Portable content lands once
under `AGENTKIT_HOME` (default `~/.agentkit`); OpenCode, Claude Code and Grok get per-**name**
symlinks into it, and Codex gets real copies. Because nothing sweeps a client directory, skills
installed from elsewhere survive an upgrade.

## Police unit

A named policy, not a file. `pkg-police` — _use the manager this project's lockfile names_ — is one unit compiled into
each harness's native mechanism: `hooks/claude/pkg-police.sh`, `plugins/pkg-police.ts`,
`policies/codex/pkg-police.rules`. The implementations are deliberately not equivalent; where the
Codex argv-prefix policy cannot express a narrow rule, it is made broader instead.

## Hook

A script the harness runs at a tool call: `PreToolUse` before, `PostToolUse` after a write. It gets
the tool payload as JSON on stdin. A `PreToolUse` hook refuses by printing a deny decision and
exiting `0`; a `PostToolUse` hook must **exit 2**, because Claude Code discards a `PostToolUse`
hook's stderr on exit 0 — the check would run and nobody would hear it.

## Guard

The refusing half of a police unit: the thing that inspects one tool call and says no, with a
message naming what to do instead and what the legitimate exception is. Guards detect and refuse.
They do not isolate, contain, or sandbox, and cannot stop code that is already running.

## Fail-closed / fail-open

Whether a component denies or permits when it cannot evaluate. `bounded-run` is fail-closed on every
preflight check. `fail-closed-hook.sh` supervises a policy hook inside the host timeout and emits a
deny if the child times out, crashes, or returns unparseable output. `agent-session` is fail-open by
contract — it must never stop a session from starting. `resource-police` warns and fails open when
`jq`, `awk` or `cat` is missing.

## Skill

A `SKILL.md` the agent loads on demand, plus whatever `references/` and `scripts/` it needs. Some
are pure playbooks; others ship working code and the playbook says when to run it. One format serves
every harness.

## Kit

An install partition declared in `skills/KITS`, a plain-text manifest read by the installer, the
Claude plugin generator and the tests alike. A skill with no membership record belongs to `core`,
which always installs, and a skill may name only one kit. The declared kits are listed in
[Skill kits](/docs/kits/), generated from the manifest.

## Explicit kit

A kit carrying an `explicit <id>` record in `skills/KITS`. It is never offered by the
interactive picker, is excluded from `--all`, and installs only via a literal `--with <id>`. When it
is not selected, the installer **removes** its previously installed hooks, tools, skills and prompt
wiring — presence without a recorded selection is not consent. `adversarial-review` is the only one.

## Rule

A markdown file in `rules/` with a `globs:` frontmatter key. OpenCode auto-loads it when the agent
edits a matching file, so it is context the agent already has rather than something it must choose
to load. Nothing enforces a rule; it is advice, always-on.

## Instruction

A markdown file in `instructions/` wired into a client's always-on global prompt. Each is delimited
by `<!-- agentkit:<name>:start -->` marker blocks so a re-install can replace its own block without
disturbing text you wrote around it. Instructions reach everything and enforce nothing.

## Profile

Two unrelated things share the word.

- A **`bounded-run` profile** is a fixed resource envelope: `canary`, `default`, `compile`,
  `browser`. The values are not tunable per invocation — they are tested together with the host
  configuration.
- A **review profile** is orchestration effort: `fast`, `balanced`, `strict`, resolved by
  `review-profile` from config, `AGENTKIT_REVIEW_PROFILE`, or `--profile`. It selects which review
  lanes run. It carries no merge authority.

## Bounded run

A command executed as argv — never a shell string — inside a transient systemd user service in
`agent-work.slice`, with fixed memory, CPU, task and timeout limits. Linux only: it needs cgroup v2
and a systemd user manager, so the installer omits `bounded-run` on macOS entirely.

## Tier

A risk classification on a review record: `trivial`, `standard`, `critical`. The minimum tier is
derived from the target policy's path-regex risk zones against the commit-bound changed paths; a
record may declare a higher tier than the minimum but never a lower one. A change touching
`.agentkit/review-policy.json` is always `critical`.

## Lane

A dimension of a review record. Two exist: `diff` (is this change correct?) and `product` (can
someone build, install and use this?). Each carries its own verdict, and the product lane also
carries a coverage value.

## Review record

The local JSON evidence index at `.agentkit/reviews/<source-branch-slug>.json`, `schema_version: 2`.
It holds the exact forge change context, the risk tier and rationale, both lane verdicts, findings,
claims, executed checks with exit codes, and adversarial analyses. It is gitignored and
machine-local — the durable artifact is the redacted evidence packet on the PR/MR.

## Merge gate

`review-police`, a `PreToolUse` hook that allows exactly one standalone `gh pr merge` /
`glab mr merge` and only when `review-gate` validates a review record against policy read from the
exact protected target commit. Direct REST, GraphQL and MCP merges, and compound or wrapped merge
commands, are refused rather than analysed. It ships only with `--with adversarial-review`.

It is a local interception gate, not an authentication boundary: the agent can write the local JSON,
so the gate cannot prove reviewer identity, independence, command execution, redaction, or the truth
of a referenced evidence link. Required forge checks and approvals remain the authority that stops a
determined bypass.
