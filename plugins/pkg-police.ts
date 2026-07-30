import type { PluginInput } from '@opencode-ai/plugin';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

type Manager = 'bun' | 'npm' | 'pnpm' | 'yarn';

const MANAGERS: Manager[] = ['bun', 'npm', 'pnpm', 'yarn'];

const LOCKFILES: Array<[Manager, string]> = [
  ['bun', 'bun.lock'],
  ['bun', 'bun.lockb'],
  ['npm', 'package-lock.json'],
  ['pnpm', 'pnpm-lock.yaml'],
  ['yarn', 'yarn.lock'],
];

// Every subcommand that rewrites package.json, node_modules or the lockfile,
// with its aliases. Longest alternative first — `i` before `install` matches
// the prefix and then fails the trailing boundary.
const MANAGED_SUBCOMMANDS: Record<'npm' | 'bun', string> = {
  npm:
    'install-ci-test|install-test|install|uninstall|init|it|i|cit|ci|add|run|remove|rm|r|update|upgrade|up|link|ln|unlink|un|test|publish|prune|dedupe|ddp|exec|create',
  bun: 'install|init|i|add|run|remove|rm|update|link|unlink|test|publish|create|x',
};

const BOUND = '[^A-Za-z0-9_-]';
// What may follow the command: an operator, a quote, or nothing — but never a
// character that continues a filename (`cat yarn.lock`, `npm installer`).
const TAIL = '($|[^A-Za-z0-9_./-])';
// A package argument, never a shell operator.
const ARG = '(?:\\s+([^-;&|<>()\\s][^;&|<>()\\s]*))?';

interface Enforcement {
  manager: Manager;
  reason: string;
}

interface Invocation {
  label: string;
  action: string;
}

function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'agentkit', 'config.yaml');
}

// Quoting a scalar is legal YAML, so `manager: "bun"` must read as bun rather
// than as an unrecognised value that silently disables the unit.
function unquote(value: string): string {
  return value.replace(/^["']/, '').replace(/["']$/, '');
}

function readConfigSection(): { manager?: string; enabled?: string } {
  let content: string;
  try {
    content = readFileSync(configPath(), 'utf-8');
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  let inSection = false;
  for (const line of content.split('\n')) {
    if (/^[^\s#]/.test(line)) {
      inSection = /^pkg-police:/.test(line);
      continue;
    }
    if (!inSection) continue;
    const match = /^\s+(manager|enabled):\s*([^\s#]+)/.exec(line);
    if (match) values[match[1]!] = unquote(match[2]!.toLowerCase());
  }
  return values;
}

// The tool payload carries no reliable cwd, so lockfile detection starts at the
// session directory and stops at the git root — a lockfile outside the
// repository says nothing about this project.
function detectFromLockfile(start: string): Enforcement | null {
  let dir = start;
  for (;;) {
    let hit: Manager | null = null;
    let lockname = '';
    for (const [manager, lock] of LOCKFILES) {
      if (!existsSync(join(dir, lock))) continue;
      if (hit === null) {
        hit = manager;
        lockname = lock;
      } else if (hit !== manager) {
        return null;
      }
    }
    if (hit) return { manager: hit, reason: `this project uses ${hit} (${lockname})` };
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveManager(dir: string): Enforcement | null {
  const { manager, enabled } = readConfigSection();
  if (manager && MANAGERS.includes(manager as Manager)) {
    return {
      manager: manager as Manager,
      reason: `agentkit config sets pkg-police.manager: ${manager}`,
    };
  }
  if (manager === 'off') return null;
  if (manager && manager !== 'auto') return null;
  if (!manager && enabled === 'false') return null;
  return detectFromLockfile(dir);
}

function actionFor(subcommand: string, arg: string | undefined): string {
  switch (subcommand) {
    case 'install':
    case 'i':
    case 'ci':
    case '':
      return arg ? 'add' : 'install';
    case 'add':
      return 'add';
    case 'uninstall':
    case 'un':
    case 'unlink':
    case 'remove':
    case 'rm':
    case 'r':
      return 'remove';
    case 'update':
    case 'up':
    case 'upgrade':
      return 'update';
    case 'link':
    case 'ln':
      return 'link';
    // Reconciling node_modules with the manifest is what a plain install does.
    case 'prune':
    case 'dedupe':
    case 'ddp':
    case 'install-test':
    case 'install-ci-test':
    case 'it':
    case 'cit':
      return 'install';
    case 'exec':
    case 'dlx':
    case 'x':
      return 'exec';
    case 'run':
      return 'run';
    case 'test':
      return 'test';
    case 'init':
      return 'init';
    case 'publish':
      return 'publish';
    case 'create':
      return 'create';
    default:
      return 'run';
  }
}

// npm and bun are runtimes too, so only their package-management subcommands
// count; pnpm and yarn are package managers whatever the subcommand. The
// subcommands live in the pattern rather than in a test after the match, so a
// managed invocation is found anywhere in the command instead of only at the
// leftmost `npm <word>` — `npm ls && npm install` must still be caught.
function detectInvocation(command: string, skip: Manager): Invocation | null {
  for (const manager of ['npm', 'bun'] as const) {
    if (manager === skip) continue;
    const exe = manager === 'bun' ? 'bunx' : 'npx';
    if (new RegExp(`(^|${BOUND})${exe}\\s`, 'i').test(command)) {
      return { label: exe, action: 'exec' };
    }
    const subs = MANAGED_SUBCOMMANDS[manager];
    const pattern = `(^|${BOUND})${manager}\\s+(${subs})${ARG}${TAIL}`;
    const match = new RegExp(pattern, 'i').exec(command);
    if (!match) continue;
    const sub = match[2]!;
    return { label: `${manager} ${sub}`, action: actionFor(sub.toLowerCase(), match[3]) };
  }
  for (const manager of ['pnpm', 'yarn'] as const) {
    if (manager === skip) continue;
    const pattern = `(^|${BOUND})${manager}(?:\\s+([\\w:@.-]+))?${ARG}${TAIL}`;
    const match = new RegExp(pattern, 'i').exec(command);
    if (!match) continue;
    const sub = match[2] ?? '';
    return { label: sub ? `${manager} ${sub}` : manager, action: actionFor(sub.toLowerCase(), match[3]) };
  }
  return null;
}

function equivalent(manager: Manager, action: string): string {
  if (action !== 'exec') return `${manager} ${action}`;
  if (manager === 'npm') return 'npx';
  if (manager === 'bun') return 'bunx';
  return `${manager} dlx`;
}

function isPkgOverride(command: string): boolean {
  return process.env.AGENTKIT_ALLOW_PKG === '1'
    || /(^|[\s;&|])AGENTKIT_ALLOW_PKG=1([\s;&|]|$)/.test(command);
}

export default async function pkgPolice(ctx: PluginInput) {
  const dir = ctx.directory || ctx.worktree || process.cwd();
  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      if (input.tool?.toLowerCase() !== 'bash') return;

      const command = output.args.command as string | undefined;
      if (!command) return;
      if (isPkgOverride(command)) return;

      const enforcement = resolveManager(dir);
      if (!enforcement) return;

      const invocation = detectInvocation(command, enforcement.manager);
      if (!invocation) return;

      throw new Error(
        `BLOCKED: '${invocation.label}' — ${enforcement.reason}. `
          + `Use '${equivalent(enforcement.manager, invocation.action)}'. `
          + `Override (only when the user approves): prefix with AGENTKIT_ALLOW_PKG=1.`,
      );
    },
  };
}
