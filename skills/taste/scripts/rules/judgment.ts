import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { unquote } from '../override.ts';
import { runBounded } from '../run.ts';
import { type Budget, BUDGET_SPENT, JUDGMENT_CALL_MS, judgmentBudget } from './budget.ts';
import type { KindOutcome, KindRequest, RuleKind } from './kinds.ts';
import { carriesSubstitution } from './pattern.ts';
import { askNoul } from './providers/typesafe.ts';
import {
  commandSegments,
  FORGE_GLOBAL_VALUED,
  GIT_GLOBAL_VALUED,
  programInvocation,
  programOf,
  programWords,
} from './tag-command.ts';

export const MAX_QUESTION_LENGTH = 500;
// Enough of a diff for the shape of a change to be legible, bounded because the
// provider is priced per input token and the hook is inside the agent's wait.
export const MAX_DIFF_LENGTH = 12000;
export const MAX_MESSAGE_LENGTH = 2000;
export const DEFAULT_THRESHOLD = 0.75;
const GIT_TIMEOUT_MS = 3000;
const DIFF_CUT = '\n[diff truncated]';
const MESSAGE_CUT = '\n[message truncated]';
const CHANGES_DIRECTORY = ['cd', 'pushd', 'popd'];

export const OCCASIONS: readonly string[] = ['commit', 'merge-request', 'any'];

const SHORT_OPTION = /^-[A-Za-z]/;
const LONG_MESSAGE = '--message=';

// Plain decimal only. `Number` accepts `0x1`, `1e-1`, `Infinity` and a padded
// string, and a threshold read from one of those is not the number its author
// wrote.
const DECIMAL = /^\d+(?:\.\d+)?$/;

export function parseThreshold(text: string): number | undefined {
  if (!DECIMAL.test(text)) return undefined;
  const value = Number(text);
  return value >= 0 && value <= 1 ? value : undefined;
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
  amend: boolean;
  // Where the command says git should run, which is not always where the hook
  // was invoked.
  options: string[];
}

function readCommit(words: readonly string[], options: string[]): Commit {
  const messages: string[] = [];
  let all = false;
  let amend = false;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--all') {
      all = true;
    } else if (word === '--amend') {
      amend = true;
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

  return { message: messages.join('\n\n'), all, amend, options };
}

type Found = { commit: Commit } | { unchecked: string } | undefined;

// A directory change anywhere ahead of the commit moves the tree it applies to,
// and the hook is told only where it was invoked. Saying so beats judging the
// wrong repository, which would refuse or clear a change nobody is making.
function commitIn(command: string): Found {
  const segments = commandSegments(command);
  for (let index = 0; index < segments.length; index += 1) {
    const invocation = programInvocation(segments[index] as string[], 'git', GIT_GLOBAL_VALUED);
    if (invocation === undefined || invocation.words[0] !== 'commit') continue;

    const changed = segments.slice(0, index)
      .some((earlier) => CHANGES_DIRECTORY.includes(programOf(earlier) ?? ''));
    if (changed) {
      return {
        unchecked: 'the command changes directory before committing, so the repository it '
          + 'commits in is not the one this check can read',
      };
    }
    return { commit: readCommit(invocation.words.slice(1), invocation.options) };
  }
  return undefined;
}

// -C is where git runs; --git-dir and --work-tree take it apart, and a diff
// read from either half on its own is not the change being committed.
function repositoryOf(commit: Commit, cwd: string): string | { unchecked: string } {
  let dir = cwd;
  for (let index = 0; index < commit.options.length; index += 1) {
    const option = commit.options[index] as string;
    const name = option.split('=')[0] as string;
    if (name === '--git-dir' || name === '--work-tree') {
      return {
        unchecked: `the commit names its own ${name}, so the tree it applies to is not one this `
          + 'check can read',
      };
    }
    if (option === '-C') {
      const value = commit.options[index + 1];
      if (value !== undefined) dir = isAbsolute(value) ? value : resolve(dir, value);
      index += 1;
    }
  }
  return dir;
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

async function gitOutput(args: string[], request: KindRequest, dir: string): Promise<Output> {
  const budget = budgetOf(request);
  const allowed = budget.grant(GIT_TIMEOUT_MS);
  if (allowed <= 0) return { unchecked: BUDGET_SPENT };

  const env = { ...request.env, LC_ALL: 'C', LANGUAGE: 'C', LANG: 'C' };
  const started = Date.now();
  const run = await runBounded(['git', '-C', dir, ...args], request.cwd, env, allowed);
  budget.spend(Date.now() - started);
  if (run.code === null || run.timedOut) {
    return { unchecked: `git could not be run in ${dir} — ${firstLine(run.err)}` };
  }
  if (!run.ok) {
    return { unchecked: `git could not read the change in ${dir} — ${firstLine(run.err)}` };
  }
  return { text: run.out };
}

function cut(text: string, cap: number, note: string): string {
  return text.length <= cap ? text : text.slice(0, cap) + note;
}

// Best effort, and deliberately so: a merge request is judged on what it adds
// to the branch it targets, and a repository that cannot name that branch is
// UNCHECKED rather than judged on the wrong range.
async function targetBranch(request: KindRequest): Promise<string | undefined> {
  const head = ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'];
  const named = await gitOutput(head, request, request.cwd);
  if ('text' in named && named.text !== '') return named.text;
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const verify = ['rev-parse', '--verify', '--quiet', candidate];
    const seen = await gitOutput(verify, request, request.cwd);
    if ('text' in seen && seen.text !== '') return candidate;
  }
  return undefined;
}

async function mergeRequestDiff(request: KindRequest): Promise<Output> {
  const branch = await targetBranch(request);
  if (branch === undefined) {
    return { unchecked: `no default branch to compare against in ${request.cwd}` };
  }
  return await gitOutput(['diff', `${branch}...HEAD`], request, request.cwd);
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

// A run of one, for a caller evaluating this kind on its own. The hook builds
// one budget per command and every judgment in it shares that.
function budgetOf(request: KindRequest): Budget {
  request.budget ??= judgmentBudget();
  return request.budget;
}

interface Subject {
  message: string;
  diff: string;
}

type Scope =
  | { subject: Subject }
  | { unchecked: string }
  | { skipped: string }
  | { out: true };

async function commitScope(request: KindRequest): Promise<Scope> {
  const found = commitIn(request.command);
  if (found === undefined) return { out: true };
  if ('unchecked' in found) return found;

  const commit = found.commit;
  const dir = repositoryOf(commit, request.cwd);
  if (typeof dir !== 'string') return dir;

  const diff = await gitOutput(commit.all ? ['diff', 'HEAD'] : ['diff', '--cached'], request, dir);
  if ('unchecked' in diff) return diff;

  const message = cut(commit.message, MAX_MESSAGE_LENGTH, MESSAGE_CUT);
  // Nothing to judge is not a judgment that found nothing. An amend is the
  // exception: with nothing staged the new message is the whole of the change.
  if (diff.text.trim() === '') {
    return commit.amend ? { subject: { message, diff: '' } } : { out: true };
  }
  return { subject: { message, diff: cut(diff.text, MAX_DIFF_LENGTH, DIFF_CUT) } };
}

async function scopeOf(on: string, request: KindRequest): Promise<Scope> {
  if (on === 'any') return { subject: { message: '', diff: '' } };
  if (on === 'commit') return await commitScope(request);

  if (on === 'merge-request') {
    if (!mergeRequestIn(request.command)) return { out: true };
    const diff = await mergeRequestDiff(request);
    if ('unchecked' in diff) return diff;
    return { subject: { message: '', diff: cut(diff.text, MAX_DIFF_LENGTH, DIFF_CUT) } };
  }

  // The lint refuses an occasion that is not registered, so reaching this means
  // the taste was never checked.
  return {
    skipped: `its rule.on ${JSON.stringify(on)} is not one of ${OCCASIONS.join(', ')}`,
  };
}

export const JUDGMENT: RuleKind = {
  name: 'judgment',
  required: ['question'],
  optional: ['on', 'threshold'],
  costly: true,

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
    if ('skipped' in scope) return { verdict: 'skipped', detail: scope.skipped };
    if ('unchecked' in scope) return { verdict: 'unchecked', detail: scope.unchecked };

    const apiKey = providerKey(request.env);
    if (apiKey === undefined) return { verdict: 'unchecked', detail: NO_KEY };

    const budget = budgetOf(request);
    const allowed = budget.grant(JUDGMENT_CALL_MS);
    if (allowed <= 0) return { verdict: 'unchecked', detail: BUDGET_SPENT };

    const override = Number(request.env.TYPESAFE_TIMEOUT_MS);
    const started = Date.now();
    const answer = await askNoul({
      apiKey,
      baseUrl: request.env.TYPESAFE_BASE_URL,
      timeoutMs: Number.isFinite(override) && override > 0 ? Math.min(override, allowed) : allowed,
      state: { command: request.command, ...scope.subject },
      instructions: { policy: request.body ?? '', question },
    });
    budget.spend(Date.now() - started);

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
