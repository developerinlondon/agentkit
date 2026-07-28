import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = join(import.meta.dir, '..');
const manifestPath = join(repoRoot, 'hooks', 'codex', 'hooks.json');
const supervisor = join(repoRoot, 'hooks', 'claude', 'fail-closed-hook.sh');
const reviewHook = join(repoRoot, 'hooks', 'claude', 'review-police.sh');
const hooksRootToken = '__AGENTKIT_CODEX_HOOKS_ROOT__';

function readManifest(): any {
  return JSON.parse(readFileSync(manifestPath, 'utf-8'));
}

function preToolUseEntries(manifest: any): any[] {
  return manifest.hooks.PreToolUse.flatMap((group: any) => group.hooks);
}

describe('Codex review hook wiring', () => {
  test('contains only the Bash and merge-tool review gate routes', () => {
    const manifest = readManifest();

    expect(Object.keys(manifest.hooks)).toEqual(['PreToolUse']);
    expect(manifest.hooks.PreToolUse).toHaveLength(2);
    expect(manifest.hooks.PreToolUse[0].matcher).toBe('Bash');

    const mergeTools = new RegExp(manifest.hooks.PreToolUse[1].matcher);
    expect(mergeTools.test('mcp__github__merge_pull_request')).toBe(true);
    expect(mergeTools.test('mcp__gitlab__merge_merge_request')).toBe(true);
    expect(mergeTools.test('Bash')).toBe(false);
    expect(mergeTools.test('Edit')).toBe(false);
  });

  test('runs both routes through the fail-closed supervisor', () => {
    const entries = preToolUseEntries(readManifest());

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toEqual({
        type: 'command',
        command:
          `AGENTKIT_HOOK_TARGET=codex "${hooksRootToken}/fail-closed-hook.sh" 45 ` +
          `"${hooksRootToken}/review-police.sh"`,
        timeout: 60,
      });
    }
  });

  test('uses one deterministic token for installer path rewriting', () => {
    const source = readFileSync(manifestPath, 'utf-8');
    const installedRoot = '/tmp/agentkit install/.codex/hooks';
    const installed = JSON.parse(source.replaceAll(hooksRootToken, installedRoot));
    const commands = preToolUseEntries(installed).map((entry) => entry.command);

    expect(source.match(new RegExp(hooksRootToken, 'g'))).toHaveLength(4);
    expect(JSON.stringify(installed)).not.toContain(hooksRootToken);
    expect(commands).toEqual([
      `AGENTKIT_HOOK_TARGET=codex "${installedRoot}/fail-closed-hook.sh" 45 "${installedRoot}/review-police.sh"`,
      `AGENTKIT_HOOK_TARGET=codex "${installedRoot}/fail-closed-hook.sh" 45 "${installedRoot}/review-police.sh"`,
    ]);
  });

  test('accepts Codex Bash input and emits the Codex deny payload', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-codex-review-hook-'));

    try {
      const result = spawnSync('bash', [supervisor, '45', reviewHook], {
        encoding: 'utf-8',
        env: { ...process.env, AGENTKIT_HOOK_TARGET: 'codex', HOME: home },
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: {
            command: 'curl -X PUT https://api.github.com/repos/owner/repo/pulls/12/merge',
          },
          session_id: 'codex-review-hook-test',
        }),
      });

      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.decision).toBe('block');
      expect(output.reason).toContain('direct REST merge');
      expect(output.hookSpecificOutput).toEqual({
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: output.reason,
      });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
