import type { CliResult } from '../run';

// A minimal JSON Schema shape — enough to describe our tool inputs for the
// MCP `tools/list` response. Kept loose on purpose; hosts do the validation.
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: ToolArgs) => Promise<CliResult>;
}

// Coerce an untyped arg into a string, or return undefined when absent.
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Coerce an untyped arg into a string[] of extra CLI flags. Anything that is
// not a string is dropped, so a malformed `opts` can never smuggle a non-arg.
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

const INVALID_ARGS = 2;

// Shared CliResult for a missing/blank required argument.
export function missingArg(name: string): CliResult {
  return { ok: false, stdout: '', stderr: `missing required argument: ${name}`, exit_code: INVALID_ARGS };
}
