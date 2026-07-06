import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// The comprehensive "agentkit" Claude Code plugin bundles, in one install:
//   - the enforcement police hooks (wired via hooks/hooks.json),
//   - the agentkit skills, and
//   - both MCP toolchains (assay + a copy of the infra-tools server).
// These tests pin that wiring so a regression (a missing/renamed script, a
// dropped MCP server, a hook that lost its executable bit) fails loudly instead
// of shipping a plugin that half-installs.

const repoRoot = join(import.meta.dir, '..');
const pluginDir = join(repoRoot, 'plugins-cc', 'agentkit');

// The police hooks wired by hooks/claude/settings.json — exactly what the plugin
// must re-wire under ${CLAUDE_PLUGIN_ROOT}. There is no comment-police.sh: the
// comment-police police ships only as an OpenCode plugin (plugins/comment-police.ts),
// so it is intentionally absent from both settings.json and this plugin.
const PRE_TOOL_USE_HOOKS = ['git-police.sh', 'kubectl-police.sh', 'pkg-police.sh', 'mr-police.sh'];
const POST_TOOL_USE_HOOKS = ['format-police.sh', 'coding-police.sh'];
const ALL_POLICE_HOOKS = [...PRE_TOOL_USE_HOOKS, ...POST_TOOL_USE_HOOKS];

function readJson(...parts: string[]): any {
  return JSON.parse(readFileSync(join(pluginDir, ...parts), 'utf-8'));
}

function commandBasenames(entries: { command: string }[]): string[] {
  return entries.map((entry) => basename(entry.command));
}

describe('agentkit plugin manifest', () => {
  test('plugin.json declares name agentkit and wires hooks, skills, and mcpServers', () => {
    const plugin = readJson('.claude-plugin', 'plugin.json');
    expect(plugin.name).toBe('agentkit');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.hooks).toBe('./hooks/hooks.json');
    expect(plugin.skills).toBe('./skills/');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });
});

describe('agentkit plugin hooks', () => {
  test('hooks.json wires exactly the police hooks under ${CLAUDE_PLUGIN_ROOT}', () => {
    const hooks = readJson('hooks', 'hooks.json').hooks;

    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(commandBasenames(hooks.PreToolUse[0].hooks).sort()).toEqual([...PRE_TOOL_USE_HOOKS].sort());

    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0].matcher).toBe('Edit|Write');
    expect(commandBasenames(hooks.PostToolUse[0].hooks).sort()).toEqual([...POST_TOOL_USE_HOOKS].sort());

    // Every command must resolve inside the plugin, never a ~/.claude path.
    const allEntries = [...hooks.PreToolUse[0].hooks, ...hooks.PostToolUse[0].hooks];
    for (const entry of allEntries) {
      expect(entry.command).toStartWith('${CLAUDE_PLUGIN_ROOT}/hooks/');
      expect(entry.command).not.toContain('.claude/hooks');
      expect(entry.type).toBe('command');
      expect(typeof entry.timeout).toBe('number');
    }
  });

  test('every referenced police script exists and is executable', () => {
    // hooks.json must reference these and they must be present + runnable.
    const referenced = new Set(
      readJson('hooks', 'hooks.json').hooks.PreToolUse[0].hooks
        .concat(readJson('hooks', 'hooks.json').hooks.PostToolUse[0].hooks)
        .map((entry: { command: string }) => basename(entry.command)),
    );

    for (const script of ALL_POLICE_HOOKS) {
      expect(referenced.has(script), `${script} referenced in hooks.json`).toBe(true);
      const mode = statSync(join(pluginDir, 'hooks', script)).mode;
      expect((mode & 0o111) !== 0, `${script} is executable`).toBe(true);
    }
  });
});

describe('agentkit plugin MCP servers', () => {
  test('.mcp.json declares both the assay and infra-tools servers', () => {
    const servers = readJson('.mcp.json').mcpServers;
    expect(Object.keys(servers).sort()).toEqual(['assay', 'infra-tools']);

    expect(servers.assay.command).toBe('assay');
    expect(servers.assay.args).toEqual(['mcp-serve']);

    expect(servers['infra-tools'].command).toBe('bun');
    // The bundled server must live inside this plugin (plugins are cached as
    // copied files — a cross-plugin path would not survive install).
    expect(servers['infra-tools'].args).toEqual(['${CLAUDE_PLUGIN_ROOT}/server/index.ts']);
  });
});

describe('agentkit plugin skills', () => {
  test('ships the agentkit skills, each with a SKILL.md', () => {
    const expectedSkills = [
      'autonomous-workflow',
      'code-quality',
      'documentation',
      'gitops-master',
      'issue-raiser',
      'project-planning',
      'test-driven-development',
    ];
    for (const skill of expectedSkills) {
      const skillMd = join(pluginDir, 'skills', skill, 'SKILL.md');
      expect(statSync(skillMd).isFile(), `${skill}/SKILL.md exists`).toBe(true);
    }
  });
});

describe('marketplace lists the agentkit plugin', () => {
  test('agentkit is present, first, and the granular plugins remain', () => {
    const marketplace = JSON.parse(
      readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf-8'),
    );
    const names = marketplace.plugins.map((p: { name: string }) => p.name);
    // Recommended one-shot first, then the à-la-carte plugins.
    expect(names).toEqual(['agentkit', 'assay', 'infra-tools']);

    const agentkit = marketplace.plugins.find((p: { name: string }) => p.name === 'agentkit');
    expect(agentkit.source).toBe('./plugins-cc/agentkit');
    expect(agentkit.version).toBe('0.1.0');
  });
});

// Reuse of the infra-tools server integration coverage against the COPY bundled
// inside the agentkit plugin: prove the server still boots and lists its tools
// from its new location (this is the smoke test the plugin depends on).
describe('bundled infra-tools server (copied into the agentkit plugin)', () => {
  const SERVER = join(pluginDir, 'server', 'index.ts');

  interface RpcResponse {
    jsonrpc: string;
    id: number | string | null;
    result?: any;
    error?: { code: number; message: string };
  }

  async function rpc(requests: object[]): Promise<RpcResponse[]> {
    const proc = Bun.spawn(['bun', SERVER], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as RpcResponse);
  }

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    },
  };

  test('initialize + tools/list works from the bundled copy', async () => {
    const responses = await rpc([initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);

    const init = responses.find((r) => r.id === 1)!;
    expect(init.error).toBeUndefined();
    expect(init.result.serverInfo).toEqual({ name: 'infra-tools', version: '0.1.0' });

    const list = responses.find((r) => r.id === 2)!;
    const names: string[] = list.result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual([
      'git_clone_ro',
      'git_diff',
      'git_log',
      'git_status',
      'helm_get_values',
      'helm_list',
      'helm_template',
      'tofu_plan',
      'tofu_show',
      'tofu_state_list',
    ]);
    // No mutating escape hatch leaked into the bundled copy.
    expect(names.some((n) => /apply|install|upgrade|uninstall|destroy|push|commit|reset/.test(n)))
      .toBe(false);
  });
});
