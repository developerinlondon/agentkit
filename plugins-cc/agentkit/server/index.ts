#!/usr/bin/env bun
// infra-tools MCP server — a stdio JSON-RPC 2.0 server exposing read-only
// helm / tofu / git tools. Newline-delimited JSON framing (the MCP stdio
// transport): one JSON object per line on stdin, one JSON object per line on
// stdout. Diagnostics go to stderr so they never corrupt the protocol channel.

import { type JsonRpcRequest, handleRequest } from './protocol';

const ERR_PARSE = -32700;

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function dispatchLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'parse error' } });
    return;
  }

  try {
    const response = await handleRequest(req);
    if (response) write(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`infra-tools: handler error: ${message}\n`);
    if (req.id !== undefined) {
      write({ jsonrpc: '2.0', id: req.id ?? null, error: { code: -32603, message } });
    }
  }
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await dispatchLine(line);
      newline = buffer.indexOf('\n');
    }
  }

  // Flush any trailing line that arrived without a terminating newline.
  await dispatchLine(buffer);
}

main().catch((err) => {
  process.stderr.write(`infra-tools: fatal: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
