---
name: uninstall
description: >-
  Remove AgentKit, or one of its skill kits, without hand-deleting files. Covers
  `install.sh --uninstall` for a global or project install, what it reverts inside
  configs the user owns, what it deliberately leaves alone, and how kit removal
  differs between opt-in and consent-gated kits. Use when asked to uninstall
  AgentKit, remove a kit, undo the installer, or clean a machine of it.
---

# Uninstalling AgentKit

Run the uninstaller from a checkout of the same repo that installed it. It removes
artifacts by the names that checkout ships and by symlinks pointing into the shared
root — never by pattern — so a file the installer did not write is never touched.

```sh
./install.sh --global --uninstall              # undo a global install
./install.sh --uninstall ~/code/my-project     # undo a project install
./install.sh --global --uninstall --purge-config   # ...and drop config.yaml too
```

It is idempotent: a second run prints nothing and exits 0, and so does a run against
a machine that never had AgentKit on it.

## Removing one kit

Kit removal is not uniform, and the difference matters before you promise a user
anything.

| Kit                                     | `install.sh --global --without <kit>`                                  |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `adversarial-review`, `advisory-review` | Fully removed — skills, hooks, `settings.json` entries, tools, prompts |
| `memory`, `product`                     | De-selected only; installed skills and hooks stay and keep updating    |

The consent-gated kits are removed because presence without a recorded selection is
not consent. An ordinary kit is deliberately left on disk: dropping it would take a
skill away from somebody mid-use. So `--without memory` changes what a future
install writes, not what is on the machine right now.

To actually get an ordinary kit off a machine, uninstall and reinstall the set you
want — the uninstall clears the remembered selection with everything else:

```sh
./install.sh --global --uninstall
./install.sh --global --with product      # memory is gone, product is back
```

## What `--uninstall` removes

- Shared root `~/.agentkit/{skills,rules,instructions,hooks,tools}`, plus its
  `kits` selection record and `version` stamp
- `~/.local/bin` copies of every tool the checkout ships, including the
  `agentkit-run` compat symlink
- Per-name symlinks into the shared root under `~/.agents`, `~/.claude` and
  `~/.grok` (skills, rules, instructions, hooks, tools)
- `~/.config/opencode/plugins/` copies of the shipped TypeScript plugins
- Codex `rules/*.rules` this checkout ships, `prompts/<skill>.md`, the review-gate
  hooks and tools, and `hooks.json` when nothing is left in it
- Session shims, the `agent-sessions.slice` unit, and the shim `PATH` block in
  `~/.bashrc`

## What it reverts inside configs you own

Each of these is edited in place, scoped to a marker or to agentkit ownership, and
the rest of the file is left exactly as it was.

| File                               | Reverted                                                      |
| ---------------------------------- | ------------------------------------------------------------- |
| `~/.claude/settings.json`          | Hook entries running an agentkit hook script                  |
| `~/.claude/CLAUDE.md`              | `<!-- agentkit:<name>:start/end -->` blocks (and legacy ones) |
| `~/.config/opencode/opencode.json` | Only the `instructions[]` entries pointing at the shared root |
| `$CODEX_HOME/config.toml`          | `developer_instructions`, only when it is the agentkit prompt |
| `$CODEX_HOME/hooks.json`           | Only entries tagged `AGENTKIT_HOOK_TARGET=codex`              |
| `~/.bashrc`                        | The `agentkit session shims` block                            |

A `settings.json` or `CLAUDE.md` with nothing at all left in it is removed; one
still holding anything of the user's is kept.

## What it preserves

- `~/.config/agentkit/config.yaml` — kept and reported, unless `--purge-config`
- Rules files in `$CODEX_HOME/rules` this checkout does not ship, such as a
  hand-written `default.rules`
- Hooks, instructions and plugins another toolkit installed alongside agentkit
- A real directory where a link into the shared root belongs — that is somebody's
  own fork of a skill, so it is reported and left in place

## Verify

```sh
test ! -e ~/.agentkit && echo "shared root gone"
ls ~/.claude/skills ~/.grok/skills 2>/dev/null            # no dangling links
find ~/.claude ~/.agents ~/.grok -xtype l 2>/dev/null     # must print nothing
grep -c agentkit ~/.claude/settings.json ~/.bashrc 2>/dev/null   # expect 0
grep developer_instructions "${CODEX_HOME:-$HOME/.codex}/config.toml"
./install.sh --global --uninstall                          # second run: silent, exit 0
```

`find -xtype l` is the assertion that matters: a leftover symlink into a deleted
shared root still exists on disk while `test -e` reports it absent, so an
existence check alone will tell you the job is done when it is not.
