import { TOOL_MAP, TOOLS } from './tools/registry';

// Minimal MCP (Model Context Protocol) method handlers over JSON-RPC 2.0.
// Only the three methods a read-only tool server needs are implemented:
// `initialize`, `tools/list`, and `tools/call`.

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export const SERVER_INFO = { name: 'infra-tools', version: '0.1.0' } as const;

// JSON-RPC error codes.
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// Returns a response object, or null for notifications (no id) which get no reply.
export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const isNotification = req.id === undefined;

  switch (req.method) {
    case 'initialize':
      return reply(req, initializeResult(req.params));
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notifications — never answered
    case 'ping':
      return reply(req, {});
    case 'tools/list':
      return reply(req, { tools: TOOLS.map(toolInfo) });
    case 'tools/call':
      return reply(req, await callTool(req.params));
    default:
      if (isNotification) return null;
      return errorReply(req, ERR_METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

function initializeResult(params?: Record<string, unknown>) {
  const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined;
  const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  };
}

function toolInfo(tool: (typeof TOOLS)[number]) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

async function callTool(params?: Record<string, unknown>) {
  const name = typeof params?.name === 'string' ? params.name : undefined;
  const tool = name ? TOOL_MAP.get(name) : undefined;
  if (!tool) {
    return textResult(`unknown tool: ${name ?? '(none)'}`, true);
  }
  const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
  const result = await tool.handler(args);
  return textResult(JSON.stringify(result, null, 2), !result.ok);
}

function textResult(text: string, isError: boolean) {
  return { content: [{ type: 'text', text }], isError };
}

function reply(req: JsonRpcRequest, result: unknown): JsonRpcResponse | null {
  if (req.id === undefined) return null;
  return { jsonrpc: '2.0', id: req.id ?? null, result };
}

export function errorReply(req: JsonRpcRequest, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: req.id ?? null, error: { code, message } };
}
