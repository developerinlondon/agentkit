import type { PluginInput } from '@opencode-ai/plugin';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Rules are data in the owner's taste files, evaluated by the taste skill's
// evaluator — the same one hooks/claude/taste-police.sh runs, so a taste cannot
// mean one thing here and another there.
interface Verdict {
  decision: 'allow' | 'deny';
  reason?: string;
  notices: string[];
}

type Evaluate = (request: { command: string; cwd: string }) => Promise<Verdict>;

function evaluatorPath(): string | null {
  const scripts = process.env.AGENTKIT_TASTE_SCRIPTS;
  const candidates = [
    ...(scripts ? [join(scripts, 'police.ts')] : []),
    join(homedir(), '.agentkit', 'skills', 'taste', 'scripts', 'police.ts'),
    join(homedir(), '.claude', 'skills', 'taste', 'scripts', 'police.ts'),
    join(import.meta.dir, '..', 'skills', 'taste', 'scripts', 'police.ts'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

let loading: Promise<Evaluate | null> | undefined;

function loadEvaluator(): Promise<Evaluate | null> {
  loading ??= (async () => {
    const path = evaluatorPath();
    if (path === null) return null;
    try {
      const module = await import(pathToFileURL(path).href);
      return typeof module.evaluateCommand === 'function'
        ? (module.evaluateCommand as Evaluate)
        : null;
    } catch {
      return null;
    }
  })();
  return loading;
}

function tastesPresent(cwd: string): boolean {
  return [
    join(cwd, '.agentkit', 'tastes'),
    // The pre-move external root, still bound for one release of grace.
    join(cwd, '.agentkit', 'tastes-vendor'),
    join(homedir(), '.agentkit', 'tastes'),
  ].some((dir) => existsSync(dir));
}

// A command can act in a repository the session is not standing in — `cd repo
// && …`, `git -C repo …`, or a wrapper carrying either. Whether that repository
// has tastes is the evaluator's question; what this decides is only whether the
// question is worth asking, because every command an agent runs pays for it.
//
// Read in command position, never anywhere in the text: `rg -C 3`, `make -C src`
// and a commit message mentioning a directory change are none of this plugin's
// business, and loading an evaluator for them is a cost with nothing at the end.
const START = '(?:^|[;&|(])\\s*';
const LAUNCHER = '(?:(?:env|timeout|nohup|sudo|nice|xargs)(?:\\s+[^;&|()\\s]+)*\\s+)?';
const CHANGES = '(?:cd|pushd|eval|bash|sh|zsh|dash|ksh)(?:\\s|$)';
const POINTS = 'git(?:\\s[^;&|()]*)?\\s(?:-C\\s|--git-dir[=\\s]|--work-tree[=\\s])';
const REACHES_ELSEWHERE = new RegExp(
  `${START}${LAUNCHER}(?:${CHANGES}|${POINTS})`,
);

export default async function tastePolice(ctx: PluginInput) {
  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      if (input.tool?.toLowerCase() !== 'bash') return;
      const command = output.args.command as string | undefined;
      if (!command) return;

      if (!tastesPresent(ctx.directory) && !REACHES_ELSEWHERE.test(command)) return;

      const evaluate = await loadEvaluator();
      if (evaluate === null) {
        // Never a refusal, and never silence where there was something to read.
        console.warn(
          'UNCHECKED: taste-police found no evaluator (the taste skill is not installed), '
            + 'so tastes at enforce: block were not applied.',
        );
        return;
      }

      let verdict: Verdict;
      try {
        verdict = await evaluate({ command, cwd: ctx.directory });
      } catch (error) {
        // A broken evaluator must not refuse every command in the session.
        console.warn(
          `UNCHECKED: taste-police could not evaluate this command (${(error as Error).message}), `
            + 'so tastes at enforce: block were not applied.',
        );
        return;
      }

      for (const notice of verdict.notices) console.warn(`taste-police: ${notice}`);
      if (verdict.decision === 'deny') throw new Error(verdict.reason);
    },
  };
}
