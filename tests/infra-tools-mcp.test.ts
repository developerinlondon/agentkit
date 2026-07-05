import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Integration test: spawns the infra-tools MCP server as a real subprocess and
// drives it over the stdio JSON-RPC transport, exactly as a host (Claude Code)
// would via the `.mcp.json` `command: bun` declaration.

const SERVER = join(import.meta.dir, '..', 'plugins-cc', 'infra-tools', 'server', 'index.ts');

const EXPECTED_TOOLS = [
  'helm_template',
  'helm_list',
  'helm_get_values',
  'tofu_plan',
  'tofu_show',
  'tofu_state_list',
  'git_log',
  'git_diff',
  'git_status',
  'git_clone_ro',
];

// Subcommands that would mutate infra — must never be reachable as a tool.
const FORBIDDEN_TOOL_NAMES = [
  'helm_install',
  'helm_upgrade',
  'helm_uninstall',
  'tofu_apply',
  'tofu_destroy',
  'git_push',
  'git_commit',
  'git_reset',
  'run',
  'exec',
  'shell',
  'sh',
];

interface RpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

// Write every request, close stdin, then read all newline-delimited responses.
// The server's read loop ends on stdin EOF, so the process exits cleanly.
async function rpc(requests: object[]): Promise<RpcResponse[]> {
  const proc = Bun.spawn(['bun', SERVER], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as RpcResponse);
}

function byId(responses: RpcResponse[], id: number): RpcResponse {
  const found = responses.find((r) => r.id === id);
  if (!found) throw new Error(`no response for id ${id} in: ${JSON.stringify(responses)}`);
  return found;
}

let repoDir: string;

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'infra-tools-git-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: repoDir, env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  };
  git(['init', '-q']);
  writeFileSync(join(repoDir, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'infra-tools fixture commit']);
});

afterAll(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

describe('infra-tools MCP server', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  };

  test('initialize handshake returns serverInfo and tools capability', async () => {
    const [res] = await rpc([initialize]);
    expect(res.error).toBeUndefined();
    expect(res.result.serverInfo).toEqual({ name: 'infra-tools', version: '0.1.0' });
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.protocolVersion).toBe('2025-06-18');
  });

  test('tools/list exposes exactly the read-only helm/tofu/git tools', async () => {
    const responses = await rpc([initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const names: string[] = byId(responses, 2).result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  test('no mutating or generic-escape-hatch tool is exposed', async () => {
    const responses = await rpc([initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const names: string[] = byId(responses, 2).result.tools.map((t: { name: string }) => t.name);
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(names).not.toContain(forbidden);
    }
    // Nothing named for apply/install/push/destroy/uninstall, however spelled.
    expect(names.some((n) => /apply|install|upgrade|uninstall|destroy|push|commit|reset/.test(n)))
      .toBe(false);
  });

  test('every tool declares a typed input schema', async () => {
    const responses = await rpc([initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    for (const tool of byId(responses, 2).result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.description).toBe('string');
    }
  });

  test('tools/call git_log runs against a fixture repo and returns the commit', async () => {
    const responses = await rpc([
      initialize,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'git_log', arguments: { dir: repoDir, opts: ['--oneline'] } },
      },
    ]);
    const result = byId(responses, 3).result;
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.exit_code).toBe(0);
    expect(payload.stdout).toContain('infra-tools fixture commit');
  });

  test('tools/call git_status returns clean working tree for the fixture', async () => {
    const responses = await rpc([
      initialize,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'git_status', arguments: { dir: repoDir } },
      },
    ]);
    const payload = JSON.parse(byId(responses, 4).result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.stdout).toContain('nothing to commit');
  });

  test('tools/call on an unknown tool is reported as an error result', async () => {
    const responses = await rpc([
      initialize,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'helm_install', arguments: {} },
      },
    ]);
    const result = byId(responses, 5).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown tool');
  });

  test('unknown JSON-RPC method returns method-not-found', async () => {
    const responses = await rpc([initialize, { jsonrpc: '2.0', id: 6, method: 'no/such/method' }]);
    expect(byId(responses, 6).error?.code).toBe(-32601);
  });

  test('malformed JSON line returns a parse error', async () => {
    const proc = Bun.spawn(['bun', SERVER], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write('{ not json }\n');
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const res = JSON.parse(out.trim()) as RpcResponse;
    expect(res.error?.code).toBe(-32700);
  });
});
