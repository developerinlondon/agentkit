import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const installSource = readFileSync(join(repoRoot, 'install.sh'), 'utf-8');
// Plugin ids come from the kit manifest, so the helpers that resolve them
// belong to the unit under test.
const functionStart = installSource.indexOf('plugin_is_installed() {');
const functionEnd = installSource.indexOf('\n# ─── User Config', functionStart);
const installFunction = installSource.slice(functionStart, functionEnd);
const globalMain = installSource.indexOf('# ─── Main: Global Install');
const callerStart = installSource.indexOf('\tif [[ "$CLAUDE_PLUGIN"', globalMain);
const callerEnd = installSource.indexOf('\techo "--- Standalone tools ---"', callerStart);
const installCaller = installSource.slice(callerStart, callerEnd);
const homes: string[] = [];

function runPluginInstall(
  installed: boolean,
  marketplaceExists = false,
  operationExit = 0,
  postInstallState = '[{"id":"agentkit@agentkit","scope":"user","enabled":true}]',
  marketplaceUpdateExit = 0,
  selectedKits = 'core',
  initialState?: string,
) {
  const home = mkdtempSync(join(tmpdir(), 'agentkit-plugin-install-'));
  homes.push(home);
  const bin = join(home, 'bin');
  const log = join(home, 'claude.log');
  const listCount = join(home, 'list-count');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$CLAUDE_CALL_LOG"
if [ "$1 $2 $3" = "plugin marketplace add" ]; then
  exit "${marketplaceExists ? 1 : 0}"
fi
if [ "$1 $2 $3" = "plugin marketplace update" ]; then
  exit "$CLAUDE_MARKETPLACE_UPDATE_EXIT"
fi
if [ "$1 $2 $3" = "plugin list --json" ]; then
  count=0
  if [ -f "$CLAUDE_LIST_COUNT" ]; then
    count="$(cat "$CLAUDE_LIST_COUNT")"
  fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$CLAUDE_LIST_COUNT"
  if [ "$count" -eq 1 ]; then
    printf '%s\\n' "$CLAUDE_PLUGIN_LIST_JSON"
  else
    printf '%s\\n' "$CLAUDE_POST_INSTALL_JSON"
  fi
  exit 0
fi
if [ "$1 $2" = "plugin install" ] || [ "$1 $2" = "plugin update" ]; then
  exit "$CLAUDE_OPERATION_EXIT"
fi
`,
  );
  chmodSync(join(bin, 'claude'), 0o755);

  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail\nREPO_DIR="$1"\nsource "$1/lib/skill-kits.sh"\nSELECTED_KITS="${selectedKits}"\nkit_selected() { case " $SELECTED_KITS " in *" $1 "*) return 0 ;; esac; return 1; }\n${installFunction}\nif install_claude_plugin; then exit 0; else exit $?; fi`,
      'bash',
      repoRoot,
    ],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_CALL_LOG: log,
        CLAUDE_LIST_COUNT: listCount,
        CLAUDE_MARKETPLACE_UPDATE_EXIT: String(marketplaceUpdateExit),
        CLAUDE_OPERATION_EXIT: String(operationExit),
        CLAUDE_PLUGIN_LIST_JSON: initialState
          ?? (installed ? '[{"id":"agentkit@agentkit","scope":"user"}]' : '[]'),
        CLAUDE_POST_INSTALL_JSON: postInstallState,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
      },
    },
  );

  return { calls: readFileSync(log, 'utf-8').trim().split('\n'), result };
}

const kitPluginState = (ids: string[]) =>
  JSON.stringify(ids.map((id) => ({ id, scope: 'user', enabled: true })));

function runKitPluginInstall(selectedKits: string, productAlreadyInstalled = false) {
  const ids = ['agentkit@agentkit', 'agentkit-product@agentkit'];
  return runPluginInstall(
    false,
    false,
    0,
    kitPluginState(ids),
    0,
    selectedKits,
    productAlreadyInstalled ? kitPluginState(['agentkit-product@agentkit']) : undefined,
  );
}

function runExplicitPluginCallerFailure() {
  const home = mkdtempSync(join(tmpdir(), 'agentkit-plugin-caller-'));
  homes.push(home);
  const manualMarker = join(home, 'manual-hooks-installed');
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
CLAUDE_PLUGIN=true
CLAUDE_HOOKS="$1/hooks"
CLAUDE_SETTINGS="$1/settings.json"
HOOKS_CANON="$1/canonical-hooks"
install_claude_plugin() { return 42; }
install_claude_hooks() { : > "$MANUAL_MARKER"; }
${installCaller}`,
      'agentkit-plugin-caller',
      home,
    ],
    {
      encoding: 'utf-8',
      env: { ...process.env, MANUAL_MARKER: manualMarker },
    },
  );

  return { manualMarker, result };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

describe('Claude plugin install lifecycle', () => {
  test('installs agentkit when no user-scoped copy exists', () => {
    const { calls, result } = runPluginInstall(false);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('plugin list --json');
    expect(calls).toContain('plugin install agentkit@agentkit');
    expect(calls).not.toContain('plugin update agentkit@agentkit');
  });

  test('refreshes the marketplace and updates an existing user-scoped copy', () => {
    const { calls, result } = runPluginInstall(true, true);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('plugin marketplace update agentkit');
    expect(calls).toContain('plugin list --json');
    expect(calls).toContain('plugin update agentkit@agentkit');
    expect(calls).not.toContain('plugin install agentkit@agentkit');
  });

  test('does not report readiness when a fresh install fails inside the caller condition', () => {
    const { result } = runPluginInstall(false, false, 42);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to install agentkit@agentkit');
    expect(result.stdout).not.toContain('Plugin ready');
  });

  test('does not continue when marketplace registration and refresh both fail', () => {
    const { result } = runPluginInstall(false, true, 0, undefined, 44);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to register the agentkit marketplace');
    expect(result.stdout).not.toContain('Plugin ready');
  });

  test('does not report readiness when an existing plugin update fails inside the caller condition', () => {
    const { result } = runPluginInstall(true, true, 43);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to update agentkit@agentkit');
    expect(result.stdout).not.toContain('Plugin ready');
  });

  test('requires the post-operation plugin state to be user-scoped and enabled', () => {
    const { result } = runPluginInstall(
      false,
      false,
      0,
      '[{"id":"agentkit@agentkit","scope":"user","enabled":false}]',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not enabled after installation');
    expect(result.stdout).not.toContain('Plugin ready');
  });

  test('installs one plugin per selected kit', () => {
    const { calls, result } = runKitPluginInstall('core product');
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('plugin install agentkit@agentkit');
    expect(calls).toContain('plugin install agentkit-product@agentkit');
  });

  test('updates an installed kit plugin the current flags did not select', () => {
    const { calls, result } = runKitPluginInstall('core', true);
    expect(result.status, result.stderr).toBe(0);
    // Same promise as a retained skill: an upgrade must not abandon what the
    // user already has installed.
    expect(calls).toContain('plugin update agentkit-product@agentkit');
    expect(calls).not.toContain('plugin install agentkit-product@agentkit');
  });

  // The plugin id is the one artifact named after a kit, so renaming a kit strands
  // a plugin under the old id. Uninstalling is destructive, so the blast radius is
  // asserted too: only retired agentkit ids, nothing else installed.
  test('uninstalls a plugin left under a retired kit id, and touches nothing else', () => {
    const { calls, result } = runPluginInstall(
      false,
      false,
      0,
      kitPluginState(['agentkit@agentkit']),
      0,
      'core',
      kitPluginState([
        'agentkit-strict-review@agentkit',
        'oh-my-claudecode@omc',
        'superpowers@claude-plugins-official',
      ]),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('plugin uninstall agentkit-strict-review@agentkit');
    expect(calls.filter((call) => call.startsWith('plugin uninstall'))).toEqual([
      'plugin uninstall agentkit-strict-review@agentkit',
    ]);
  });

  // A kit with no skills publishes no plugin, so asking to install one aborts
  // the whole run. The guard lives in claude_plugin_targets; this pins it.
  test('a selected kit with no skills requests no plugin', () => {
    const { calls, result } = runKitPluginInstall('core advisory-review');
    expect(result.status, result.stderr).toBe(0);
    expect(calls.join('\n')).not.toContain('agentkit-advisory-review@agentkit');
  });

  test('a retired id that is not installed is not uninstalled', () => {
    const { calls, result } = runKitPluginInstall('core');
    expect(result.status, result.stderr).toBe(0);
    expect(calls.some((call) => call.startsWith('plugin uninstall'))).toBe(false);
  });

  test('explicit plugin mode propagates lifecycle failure without installing manual hooks', () => {
    const { manualMarker, result } = runExplicitPluginCallerFailure();

    expect(result.status).toBe(42);
    expect(existsSync(manualMarker)).toBe(false);
    expect(result.stdout).not.toContain('Falling back to manual install');
  });
});
