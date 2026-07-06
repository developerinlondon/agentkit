import { gitTools } from './git';
import { helmTools } from './helm';
import { tofuTools } from './tofu';
import type { ToolDef } from './types';

// The complete, fixed set of exposed tools. There is deliberately no generic
// "run any subcommand" escape hatch — every tool binds a hardcoded, read-only
// subcommand. Mutating operations (helm install/upgrade/uninstall, tofu
// apply/destroy, git push/commit/reset) are simply not represented here.
export const TOOLS: ToolDef[] = [...helmTools, ...tofuTools, ...gitTools];

export const TOOL_MAP: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
