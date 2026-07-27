import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const installSource = readFileSync(join(repoRoot, 'install.sh'), 'utf-8');
const functionStart = installSource.indexOf('install_claude_plugin() {');
const functionEnd = installSource.indexOf('\n# ─── User Config', functionStart);
const installFunction = installSource.slice(functionStart, functionEnd);
const homes: string[] = [];

function runPluginInstall(installed: boolean, marketplaceExists = false) {
  const home = mkdtempSync(join(tmpdir(), 'agentkit-plugin-install-'));
  homes.push(home);
  const bin = join(home, 'bin');
  const log = join(home, 'claude.log');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$CLAUDE_CALL_LOG"
if [ "$1 $2 $3" = "plugin marketplace add" ]; then
  exit "${marketplaceExists ? 1 : 0}"
fi
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s\\n' "$CLAUDE_PLUGIN_LIST_JSON"
fi
`,
  );
  chmodSync(join(bin, 'claude'), 0o755);

  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nREPO_DIR="$1"\n${installFunction}\ninstall_claude_plugin`, 'bash', repoRoot],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_CALL_LOG: log,
        CLAUDE_PLUGIN_LIST_JSON: installed
          ? '[{"id":"agentkit@agentkit","scope":"user"}]'
          : '[]',
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
      },
    },
  );

  return { calls: readFileSync(log, 'utf-8').trim().split('\n'), result };
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
});
