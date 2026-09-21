import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unquote } from '../override.ts';
import { runBounded } from '../run.ts';
import type { KindOutcome, KindRequest, RuleKind } from './kinds.ts';
import { carriesSubstitution } from './pattern.ts';
import { askNoul } from './providers/typesafe.ts';
import {
  commandSegments,
  FORGE_GLOBAL_VALUED,
  GIT_GLOBAL_VALUED,
  programWords,
} from './tag-command.ts';

export const MAX_QUESTION_LENGTH = 500;
// Enough of a diff for the shape of a change to be legible, bounded because the
// provider is priced per input token and the hook is inside the agent's wait.
export const MAX_DIFF_LENGTH = 12000;
export const DEFAULT_THRESHOLD = 0.75;
const GIT_TIMEOUT_MS = 3000;
const TRUNCATED = '\n[diff truncated]';

export const OCCASIONS: readonly string[] = ['commit', 'merge-request', 'any'];

const SHORT_OPTION = /^-[A-Za-z]/;
const LONG_MESSAGE = '--message=';

export function parseThreshold(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return value;
}

// git reads a short cluster left to right and `m` takes the rest of the token
// as its value, so `-am"fix"` is --all carrying the message `fix`.
function readCluster(token: string): { all: boolean; message?: string; wantsNext: boolean } {
  let all = false;
  for (let index = 1; index < token.length; index += 1) {
    const letter = token[index] as string;
    if (letter === 'a') all = true;
    if (letter === 'm') {
      const rest = token.slice(index + 1);
      return { all, message: rest === '' ? undefined : unquote(rest), wantsNext: rest === '' };
    }
  }
  return { all, wantsNext: false };
}

interface Commit {
  message: string;
  all: boolean;
}

function readCommit(words: readonly string[]): Commit {
  const messages: string[] = [];
  let all = false;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--all') {
      all = true;
    } else if (word.startsWith(LONG_MESSAGE)) {
      messages.push(word.slice(LONG_MESSAGE.length));
    } else if (word === '--message') {
      const value = words[index + 1];
      if (value !== undefined) messages.push(value);
      index += 1;
    } else if (SHORT_OPTION.test(word)) {
      const cluster = readCluster(word);
      all = all || cluster.all;
      if (cluster.message !== undefined) messages.push(cluster.message);
      if (cluster.wantsNext) {
        const value = words[index + 1];
        if (value !== undefined) messages.push(value);
        index += 1;
      }
    }
  }

  return { message: messages.join('\n\n'), all };
}

function commitIn(command: string): Commit | undefined {
  for (const segment of commandSegments(command)) {
    const words = programWords(segment, 'git', GIT_GLOBAL_VALUED);
    if (words === undefined || words.shift() !== 'commit') continue;
    return readCommit(words);
  }
  return undefined;
}

function mergeRequestIn(command: string): boolean {
  for (const segment of commandSegments(command)) {
    const gh = programWords(segment, 'gh', FORGE_GLOBAL_VALUED);
    if (gh?.[0] === 'pr' && gh[1] === 'create') return true;
    const glab = programWords(segment, 'glab', FORGE_GLOBAL_VALUED);
    if (glab?.[0] === 'mr' && glab[1] === 'create') return true;
  }
  return false;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? 'no output';
}

type Output = { text: string } | { unchecked: string };

async function gitOutput(args: string[], request: KindRequest): Promise<Output> {
  const env = { ...request.env, LC_ALL: 'C', LANGUAGE: 'C', LANG: 'C' };
  const run = await runBounded(
    ['git', '-C', request.cwd, ...args],
    request.cwd,
    env,
    GIT_TIMEOUT_MS,
  );
  if (run.code === null || run.timedOut) {
    return { unchecked: `git could not be run in ${request.cwd} — ${firstLine(run.err)}` };
  }
  if (!run.ok) {
    return { unchecked: `git could not read the change in ${request.cwd} — ${firstLine(run.err)}` };
  }
  return { text: run.out };
}

function capped(diff: string): string {
  if (diff.length <= MAX_DIFF_LENGTH) return diff;
  return diff.slice(0, MAX_DIFF_LENGTH) + TRUNCATED;
}

// Best effort, and deliberately so: a merge request is judged on what it adds
// to the branch it targets, and a repository that cannot name that branch is
// UNCHECKED rather than judged on the wrong range.
async function targetBranch(request: KindRequest): Promise<string | undefined> {
  const named = await gitOutput(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], request);
  if ('text' in named && named.text !== '') return named.text;
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const seen = await gitOutput(['rev-parse', '--verify', '--quiet', candidate], request);
    if ('text' in seen && seen.text !== '') return candidate;
  }
  return undefined;
}

async function mergeRequestDiff(request: KindRequest): Promise<Output> {
  const branch = await targetBranch(request);
  if (branch === undefined) {
    return { unchecked: `no default branch to compare against in ${request.cwd}` };
  }
  return await gitOutput(['diff', `${branch}...HEAD`], request);
}

// The key never reaches a command line or a log: it is read here and handed
// straight to the provider call.
function providerKey(env: Record<string, string | undefined>): string | undefined {
  const named = env.TYPESAFE_API_KEY?.trim();
  if (named !== undefined && named !== '') return named;

  const xdg = env.XDG_CONFIG_HOME;
  const config = xdg === undefined || xdg === '' ? join(env.HOME ?? homedir(), '.config') : xdg;
  try {
    const stored = readFileSync(join(config, 'agentkit', 'typesafe-token'), 'utf-8').trim();
    return stored === '' ? undefined : stored;
  } catch {
    return undefined;
  }
}

const NO_KEY = 'no judgment provider key: set TYPESAFE_API_KEY or write '
  + '~/.config/agentkit/typesafe-token';

interface Subject {
  message: string;
  diff: string;
}

type Scope = { subject: Subject } | { unchecked: string } | { out: true };

async function scopeOf(on: string, request: KindRequest): Promise<Scope> {
  if (on === 'any') return { subject: { message: '', diff: '' } };

  if (on === 'merge-request') {
    if (!mergeRequestIn(request.command)) return { out: true };
    const diff = await mergeRequestDiff(request);
    if ('unchecked' in diff) return diff;
    return { subject: { message: '', diff: capped(diff.text) } };
  }

  const commit = commitIn(request.command);
  if (commit === undefined) return { out: true };
  const diff = await gitOutput(commit.all ? ['diff', 'HEAD'] : ['diff', '--cached'], request);
  if ('unchecked' in diff) return diff;
  // Nothing to judge is not a judgment that found nothing: a commit with an
  // empty diff carries no change for the taste to be broken by.
  if (diff.text.trim() === '') return { out: true };
  return { subject: { message: commit.message, diff: capped(diff.text) } };
}

export const JUDGMENT: RuleKind = {
  name: 'judgment',
  required: ['question'],
  optional: ['on', 'threshold'],

  validate(fields: Record<string, string>): string[] {
    const errors: string[] = [];
    const question = fields.question;
    if (question !== undefined) {
      if (question.trim() === '') {
        errors.push('rule.question is empty — it is the yes/no the model answers');
      }
      if (question.length > MAX_QUESTION_LENGTH) {
        errors.push(
          `rule.question is ${question.length} characters — the cap is ${MAX_QUESTION_LENGTH}, `
            + 'because it is sent with every judged command. Say the one thing it asks.',
        );
      }
      if (carriesSubstitution(question)) {
        errors.push(
          'rule.question carries a command substitution — a question is plain prose; name the '
            + 'command without backticks or $()',
        );
      }
    }
    if (fields.on !== undefined && !OCCASIONS.includes(fields.on)) {
      errors.push(`rule.on: ${JSON.stringify(fields.on)} is not one of ${OCCASIONS.join(', ')}`);
    }
    if (fields.threshold !== undefined && parseThreshold(fields.threshold) === undefined) {
      errors.push(
        `rule.threshold: ${JSON.stringify(fields.threshold)} is not a number between 0 and 1`,
      );
    }
    return errors;
  },

  async evaluate(fields: Record<string, string>, request: KindRequest): Promise<KindOutcome> {
    // The lint refuses a rule with no question, so reaching this means the
    // taste was never checked. Said out loud rather than sent as the string
    // "undefined", which the model would answer something about.
    const question = fields.question;
    if (question === undefined || question.trim() === '') {
      return {
        verdict: 'skipped',
        detail: 'its rule.question is missing — a judgment rule is the question it asks',
      };
    }

    const scope = await scopeOf(fields.on ?? 'commit', request);
    if ('out' in scope) return { verdict: 'passes' };
    if ('unchecked' in scope) return { verdict: 'unchecked', detail: scope.unchecked };

    const apiKey = providerKey(request.env);
    if (apiKey === undefined) return { verdict: 'unchecked', detail: NO_KEY };

    const timeout = Number(request.env.TYPESAFE_TIMEOUT_MS);
    const answer = await askNoul({
      apiKey,
      baseUrl: request.env.TYPESAFE_BASE_URL,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      state: { command: request.command, ...scope.subject },
      instructions: { policy: request.body ?? '', question },
    });

    if (!answer.ok) {
      return {
        verdict: 'unchecked',
        detail: `the judgment provider did not answer — ${answer.reason}`,
      };
    }

    const threshold = parseThreshold(fields.threshold ?? '') ?? DEFAULT_THRESHOLD;
    if (answer.noul < threshold) return { verdict: 'passes' };
    return {
      verdict: 'fires',
      finding: `the change reads as breaking this taste (p=${answer.noul.toFixed(2)})`,
    };
  },
};
