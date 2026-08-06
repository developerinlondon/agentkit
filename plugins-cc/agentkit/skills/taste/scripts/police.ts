import { homedir } from 'node:os';
import { offValueLine, type Override, readOverride, unquote } from './override.ts';
import { type ResolvedTaste, resolveTastes } from './resolve.ts';
import { configFiles, tasteSection } from './sources.ts';

// The rule's pattern is capped where the lint can refuse it; the subject is
// capped here. Neither bounds backtracking: a 200-character pattern well inside
// both caps can still take longer than the session has, so the match runs under
// a wall-clock deadline as well.
export const MAX_SUBJECT_LENGTH = 4000;
export const MATCH_DEADLINE_MS = 250;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

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

function tasteEnabled(
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): boolean {
  for (const path of configFiles(cwd, home, env)) {
    const enabled = tasteSection(path)?.enabled;
    if (typeof enabled === 'boolean') return enabled;
  }
  return true;
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
  return readOverride(assignedInline(command, name) ?? env[name]);
}

type MatchOutcome = { matched: boolean } | { skipped: string };

// The deadline has to live here rather than in either adapter: the OpenCode lane
// runs the match in the editor's own process, where a pattern that backtracks
// takes the session with it and no outer timeout can reach.
class BoundedMatcher {
  private worker: Worker | undefined;

  async test(pattern: string, command: string): Promise<MatchOutcome> {
    const worker = (this.worker ??= new Worker(new URL('./match.ts', import.meta.url).href));
    const subject = command.slice(0, MAX_SUBJECT_LENGTH);

    return await new Promise<MatchOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.stop();
        resolve({
          skipped: `its rule.match did not finish within ${MATCH_DEADLINE_MS}ms — the pattern `
            + 'backtracks catastrophically on this command. Narrow it, or keep the taste at check',
        });
      }, MATCH_DEADLINE_MS);

      worker.onmessage = (event: MessageEvent) => {
        clearTimeout(timer);
        const result = event.data as { matched?: boolean; failed?: string };
        resolve(
          result.failed === undefined
            ? { matched: result.matched === true }
            : { skipped: `its rule.match could not be run: ${result.failed}` },
        );
      };
      worker.onerror = (event: ErrorEvent) => {
        clearTimeout(timer);
        this.stop();
        resolve({ skipped: `its rule.match could not be run: ${event.message}` });
      };

      worker.postMessage({ pattern, subject });
    });
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = undefined;
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
  return `${offValueLine(name, override.value)}, so the taste still applies. ${deliberate}`;
}

// A taste that was skipped — malformed, or a pattern that outran the deadline —
// travels with the refusal too. Otherwise the one message the agent reads says
// enforcement happened while some of it silently did not.
function refusal(
  taste: ResolvedTaste,
  override: Override,
  cwd: string,
  home: string,
  notices: string[],
): string {
  const lines = [
    `BLOCKED by taste ${taste.name} (enforce: block): this command matches rule.match in `
      + `${displayPath(taste.path, cwd, home)}.`,
    taste.rule?.remedy ?? '',
    overrideLine(taste, override),
  ];
  if (notices.length > 0) lines.push(`Also: ${notices.join(' | ')}`);
  return lines.filter((line) => line !== '').join('\n');
}

function blocking(taste: ResolvedTaste): boolean {
  return taste.enforce === 'block' && taste.rule?.kind === 'command';
}

export async function evaluateCommand(request: Request): Promise<Verdict> {
  const home = request.home ?? homedir();
  const env = request.env ?? process.env;
  if (!tasteEnabled(request.cwd, home, env)) return { decision: 'allow', notices: [] };

  const { tastes, warnings } = resolveTastes(request.cwd, home, env);
  const notices = warnings.map((warning) => `taste skipped — ${warning}`);
  const matcher = new BoundedMatcher();

  try {
    for (const taste of tastes.filter(blocking)) {
      const outcome = await matcher.test(taste.rule?.match as string, request.command);
      if ('skipped' in outcome) {
        notices.push(`taste ${taste.name} was not applied — ${outcome.skipped} (${taste.path}).`);
        continue;
      }
      if (!outcome.matched) continue;

      const override = overrideState(taste.rule?.override, request.command, env);
      if (override.state === 'granted') {
        notices.push(
          `taste ${taste.name} allowed this command: ${taste.rule?.override} is set deliberately.`,
        );
        continue;
      }
      return {
        decision: 'deny',
        reason: refusal(taste, override, request.cwd, home, notices),
        notices,
      };
    }
  } finally {
    matcher.stop();
  }

  return { decision: 'allow', notices };
}

// The hook lane's entry point: one JSON request on stdin, one JSON verdict on
// stdout. The command never reaches a shell, and no rule data is ever
// interpolated into one.
if (import.meta.main) {
  const request = JSON.parse(await Bun.stdin.text()) as Request;
  const verdict = await evaluateCommand({ command: request.command, cwd: request.cwd });
  console.log(JSON.stringify(verdict));
}
