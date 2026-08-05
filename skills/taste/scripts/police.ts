import { YAML } from 'bun';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ResolvedTaste, resolveTastes } from './resolve.ts';

// The rule's pattern is capped where the lint can refuse it; the subject is
// capped here. Together they bound how long a hostile or careless regular
// expression can backtrack before a command is let through.
export const MAX_SUBJECT_LENGTH = 4000;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

export interface Verdict {
  decision: 'allow' | 'deny';
  reason?: string;
  notices: string[];
}

export interface Request {
  command: string;
  cwd: string;
  home?: string;
  env?: Record<string, string | undefined>;
}

function readConfigFlag(path: string): boolean | undefined {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const taste = (parsed as Record<string, unknown>).taste;
  if (typeof taste !== 'object' || taste === null) return undefined;
  const enabled = (taste as Record<string, unknown>).enabled;
  return typeof enabled === 'boolean' ? enabled : undefined;
}

function tasteEnabled(
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): boolean {
  const project = readConfigFlag(join(cwd, '.agentkit', 'config.yaml'));
  if (project !== undefined) return project;
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return readConfigFlag(join(configHome, 'agentkit', 'config.yaml')) ?? true;
}

type Override =
  | { state: 'absent' }
  | { state: 'granted'; value: string }
  | { state: 'off'; value: string };

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

// An inline assignment never reaches the hook's own environment, so the text of
// the command is where a deliberate, visible override actually lives. Same
// treatment as the branch WIP cap in hooks/claude/git-police.sh.
function assignedInline(command: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s;&|(])${name}=([^\\s;&|]*)`).exec(command);
  return match === null ? undefined : unquote(match[1] as string);
}

function overrideState(
  name: string | undefined,
  command: string,
  env: Record<string, string | undefined>,
): Override {
  if (name === undefined || !ENV_NAME.test(name)) return { state: 'absent' };
  const inline = assignedInline(command, name);
  const raw = inline ?? env[name];
  if (raw === undefined) return { state: 'absent' };
  const value = unquote(raw).trim();
  if (OFF_VALUES.has(value.toLowerCase())) return { state: 'off', value: raw };
  return { state: 'granted', value };
}

function matches(pattern: string, command: string): boolean {
  try {
    return new RegExp(pattern).test(command.slice(0, MAX_SUBJECT_LENGTH));
  } catch {
    return false;
  }
}

function displayPath(path: string, cwd: string, home: string): string {
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function overrideLine(taste: ResolvedTaste, override: Override): string {
  const name = taste.rule?.override;
  if (name === undefined) {
    return 'This taste declares no override: comply, or change the taste with the owner.';
  }
  const deliberate = `Override, when this is deliberate: prefix the command with ${name}=1.`;
  if (override.state !== 'off') return deliberate;
  return `${name}=${JSON.stringify(override.value)} does not read as a deliberate override `
    + `(empty, 0, false, no and off switch nothing on), so the taste still applies. ${deliberate}`;
}

function refusal(
  taste: ResolvedTaste,
  override: Override,
  cwd: string,
  home: string,
  warnings: string[],
): string {
  const lines = [
    `BLOCKED by taste ${taste.name} (enforce: block): this command matches rule.match in `
      + `${displayPath(taste.path, cwd, home)}.`,
    taste.rule?.remedy ?? '',
    overrideLine(taste, override),
  ];
  if (warnings.length > 0) lines.push(`Skipped taste files: ${warnings.join(' | ')}`);
  return lines.filter((line) => line !== '').join('\n');
}

function blocking(taste: ResolvedTaste): boolean {
  return taste.enforce === 'block' && taste.rule?.kind === 'command';
}

export function evaluateCommand(request: Request): Verdict {
  const home = request.home ?? homedir();
  const env = request.env ?? process.env;
  if (!tasteEnabled(request.cwd, home, env)) return { decision: 'allow', notices: [] };

  const { tastes, warnings } = resolveTastes(request.cwd, home);
  const notices = warnings.map((warning) => `taste skipped — ${warning}`);

  for (const taste of tastes.filter(blocking)) {
    if (!matches(taste.rule?.match as string, request.command)) continue;

    const override = overrideState(taste.rule?.override, request.command, env);
    if (override.state === 'granted') {
      notices.push(
        `taste ${taste.name} allowed this command: ${taste.rule?.override} is set deliberately.`,
      );
      continue;
    }
    return {
      decision: 'deny',
      reason: refusal(taste, override, request.cwd, home, warnings),
      notices,
    };
  }

  return { decision: 'allow', notices };
}

// The hook lane's entry point: one JSON request on stdin, one JSON verdict on
// stdout. The command never reaches a shell, and no rule data is ever
// interpolated into one.
if (import.meta.main) {
  const request = JSON.parse(await Bun.stdin.text()) as Request;
  console.log(JSON.stringify(evaluateCommand({ command: request.command, cwd: request.cwd })));
}
