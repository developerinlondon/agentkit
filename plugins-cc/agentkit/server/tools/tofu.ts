import { runCli } from '../run';
import { asString, asStringArray, type ToolDef } from './types';

// OpenTofu / Terraform tools — plan/read subcommands only. `plan` previews a
// change set and never applies it; `show` and `state list` are read-only. There
// is no path to `apply` or `destroy` because the subcommand is hardcoded.
//
// The working directory is passed via the spawn cwd (not an argv positional),
// so no user string is ever parsed as a flag or a global option.

// Prefer `tofu`; fall back to `terraform` when tofu is not on PATH.
function tofuBin(): string {
  if (Bun.which('tofu')) return 'tofu';
  if (Bun.which('terraform')) return 'terraform';
  return 'tofu';
}

const dirProp = {
  dir: {
    type: 'string',
    description: 'Working directory containing the OpenTofu/Terraform configuration.',
  },
};

export const tofuTools: ToolDef[] = [
  {
    name: 'tofu_plan',
    description:
      'Preview infrastructure changes with `tofu plan` (falls back to `terraform plan`). '
      + 'Plan only — this never applies or destroys anything.',
    inputSchema: {
      type: 'object',
      properties: {
        ...dirProp,
        opts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Extra args appended to `plan` (e.g. -var, -var-file, -target, -no-color). '
            + 'Preview only — never applies.',
        },
      },
      required: ['dir'],
      additionalProperties: false,
    },
    handler: (args) => {
      const dir = asString(args.dir) ?? '.';
      return runCli([tofuBin(), 'plan', ...asStringArray(args.opts)], dir);
    },
  },
  {
    name: 'tofu_show',
    description:
      'Show the current state or a saved plan with `tofu show` (read-only; '
      + 'falls back to `terraform show`).',
    inputSchema: {
      type: 'object',
      properties: { ...dirProp },
      additionalProperties: false,
    },
    handler: (args) => runCli([tofuBin(), 'show'], asString(args.dir) ?? '.'),
  },
  {
    name: 'tofu_state_list',
    description:
      'List resources tracked in state with `tofu state list` (read-only; '
      + 'falls back to `terraform state list`).',
    inputSchema: {
      type: 'object',
      properties: { ...dirProp },
      additionalProperties: false,
    },
    handler: (args) => runCli([tofuBin(), 'state', 'list'], asString(args.dir) ?? '.'),
  },
];
