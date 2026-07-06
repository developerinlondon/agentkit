import { runCli } from '../run';
import { asString, asStringArray, missingArg, type ToolDef } from './types';

// Helm tools — strictly read/render subcommands. `template` renders a chart
// locally (no cluster write, no install); `list` and `get values` only read.
// The subcommand is hardcoded here; callers can never turn these into
// install/upgrade/uninstall because they cannot choose the subcommand.

export const helmTools: ToolDef[] = [
  {
    name: 'helm_template',
    description:
      'Render a Helm chart locally with `helm template` (no install, no cluster mutation). '
      + 'Use to inspect the manifests a chart would produce.',
    inputSchema: {
      type: 'object',
      properties: {
        chart: {
          type: 'string',
          description: 'Chart reference: a local path, a packaged .tgz, or repo/chart.',
        },
        opts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Extra args appended to `helm template` (e.g. --set, --values, --namespace, '
            + '--generate-name, a release name). Rendering only — never installs.',
        },
      },
      required: ['chart'],
      additionalProperties: false,
    },
    handler: (args) => {
      const chart = asString(args.chart);
      if (!chart) return Promise.resolve(missingArg('chart'));
      return runCli(['helm', 'template', chart, ...asStringArray(args.opts)]);
    },
  },
  {
    name: 'helm_list',
    description: 'List installed Helm releases with `helm list` (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'Namespace to list releases in. Omit to use the current context namespace.',
        },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const namespace = asString(args.namespace);
      const argv = ['helm', 'list'];
      if (namespace) argv.push('--namespace', namespace);
      return runCli(argv);
    },
  },
  {
    name: 'helm_get_values',
    description: 'Show the user-supplied values of a release with `helm get values` (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        release: { type: 'string', description: 'Release name to read values from.' },
        namespace: {
          type: 'string',
          description: 'Namespace the release lives in. Omit to use the current context namespace.',
        },
      },
      required: ['release'],
      additionalProperties: false,
    },
    handler: (args) => {
      const release = asString(args.release);
      if (!release) return Promise.resolve(missingArg('release'));
      const namespace = asString(args.namespace);
      const argv = ['helm', 'get', 'values', release];
      if (namespace) argv.push('--namespace', namespace);
      return runCli(argv);
    },
  },
];
