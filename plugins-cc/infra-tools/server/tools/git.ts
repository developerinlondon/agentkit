import { runCli } from '../run';
import { asString, asStringArray, missingArg, type ToolDef } from './types';

// Git tools — local read subcommands plus one read-only clone. `log`, `diff`,
// and `status` inspect an existing repo (working directory via spawn cwd, so no
// user string is parsed as a global git option). `git_clone_ro` is the only
// write-to-disk op: it shallow-clones a remote INTO `dest` for inspection. It
// never pushes, commits, or mutates the source, and it does not accept
// free-form flags (which could smuggle `-c core.sshCommand=...` style RCE).

const SHALLOW_DEPTH = '1';

export const gitTools: ToolDef[] = [
  {
    name: 'git_log',
    description: 'Show commit history of a local repo with `git log` (read-only).',
    inputSchema: repoSchema({
      opts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra args appended to `git log` (e.g. --oneline, -n 20, --stat, a ref).',
      },
    }),
    handler: (args) => runInRepo(args, ['log', ...asStringArray(args.opts)]),
  },
  {
    name: 'git_diff',
    description: 'Show changes in a local repo with `git diff` (read-only).',
    inputSchema: repoSchema({
      opts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra args appended to `git diff` (e.g. --stat, HEAD~1, a path, --cached).',
      },
    }),
    handler: (args) => runInRepo(args, ['diff', ...asStringArray(args.opts)]),
  },
  {
    name: 'git_status',
    description: 'Show the working-tree status of a local repo with `git status` (read-only).',
    inputSchema: repoSchema(),
    handler: (args) => runInRepo(args, ['status']),
  },
  {
    name: 'git_clone_ro',
    description:
      'Shallow, read-only clone of a remote repo into `dest` for inspection. '
      + 'Depth 1, no tags; never pushes or mutates the source. This is the only '
      + 'tool that writes to disk (the local clone), and it writes nothing back.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Remote repository URL to clone (read-only).' },
        dest: { type: 'string', description: 'Local destination directory for the clone.' },
        ref: {
          type: 'string',
          description: 'Optional branch or tag to check out (single-branch shallow clone).',
        },
      },
      required: ['url', 'dest'],
      additionalProperties: false,
    },
    handler: (args) => {
      const url = asString(args.url);
      const dest = asString(args.dest);
      if (!url) return Promise.resolve(missingArg('url'));
      if (!dest) return Promise.resolve(missingArg('dest'));
      const argv = ['git', 'clone', '--depth', SHALLOW_DEPTH, '--no-tags'];
      const ref = asString(args.ref);
      if (ref) argv.push('--single-branch', '--branch', ref);
      // `--` terminates option parsing so a url/dest starting with `-` cannot be
      // treated as a flag.
      argv.push('--', url, dest);
      return runCli(argv);
    },
  },
];

function repoSchema(extra: Record<string, unknown> = {}) {
  return {
    type: 'object' as const,
    properties: {
      dir: { type: 'string', description: 'Path to the local git repository.' },
      ...extra,
    },
    required: ['dir'],
    additionalProperties: false,
  };
}

function runInRepo(args: Record<string, unknown>, argv: string[]) {
  const dir = asString(args.dir);
  if (!dir) return Promise.resolve(missingArg('dir'));
  return runCli(['git', ...argv], dir);
}
