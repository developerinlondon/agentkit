import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unquote } from '../override.ts';
import { runBounded } from '../run.ts';
import { type Budget, BUDGET_SPENT, JUDGMENT_CALL_MS, judgmentBudget } from './budget.ts';
import type { KindOutcome, KindRequest, RuleKind } from './kinds.ts';
import { carriesSubstitution } from './pattern.ts';
import { askNoul, type NoulAnswer } from './providers/typesafe.ts';
import {
  type Hit,
  MAX_WRAPPER_DEPTH,
  directoryOf,
  unreadableQuoting,
  walk,
} from './scope.ts';
import {
  commandSegments,
  FORGE_GLOBAL_VALUED,
  GIT_GLOBAL_VALUED,
  programInvocation,
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
  cwd: string;
}

function readCommit(words: readonly string[], options: string[], cwd: string): Commit {
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

  return { message: messages.join('\n\n'), all, amend, options, cwd };
}

// What was read, and what could not be. Both at once: a command can name a
// commit this follows and then go somewhere it does not.
interface Found {
  commits: Commit[];
  unread?: string;
}

// A program whose job is to run another one. It is not the command; what it
// launches is, so a commit or a shell behind one is read exactly as it would be
// in front. Anything not on this list is a program that might do anything, and
// what it runs stays out of sight.
function commitAt(segment: readonly string[], dir: string): Commit | undefined {
  const invocation = programInvocation(segment, 'git', GIT_GLOBAL_VALUED);
  if (invocation === undefined || invocation.words[0] !== 'commit') return undefined;
  return readCommit(invocation.words.slice(1), invocation.options, dir);
}

function commitIn(command: string, cwd: string): Found | undefined {
  const segments = commandSegments(command);
  const quoting = unreadableQuoting(command, segments);
  if (quoting !== undefined) {
    return {
      commits: [],
      unread: `the command carries ${quoting}, so whether it commits, and what it commits, `
        + 'is not something this check can read',
    };
  }
  const found = walk(segments, cwd, 0, commitAt);
  if (found.hits.length === 0 && found.unread === undefined) return undefined;
  return { commits: found.hits, unread: found.unread };
}



function openingAt(segment: readonly string[]): true | undefined {
  const gh = programWords(segment, 'gh', FORGE_GLOBAL_VALUED);
  if (gh?.[0] === 'pr' && gh[1] === 'create') return true;
  const glab = programWords(segment, 'glab', FORGE_GLOBAL_VALUED);
  if (glab?.[0] === 'mr' && glab[1] === 'create') return true;
  return undefined;
}

// The same reader the commit side uses, so a forge command inside a wrapper is
// seen exactly as one outside it.
function mergeRequestIn(command: string, cwd: string): Hit<true> | undefined {
  const segments = commandSegments(command);
  const quoting = unreadableQuoting(command, segments);
  if (quoting !== undefined) {
    return {
      hits: [],
      unread: `the command carries ${quoting}, so whether it opens a merge request is not `
        + 'something this check can read',
    };
  }
  const found = walk(segments, cwd, 0, openingAt);
  if (found.hits.length === 0 && found.unread === undefined) return undefined;
  return found;
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

// Which commit, when the command writes more than one: a refusal naming "the
// change" is no help when the agent is about to write three of them.
function finding(subject: Subject, noul: number, several: boolean): string {
  const line = firstLine(subject.message);
  const which = several && subject.message.trim() !== ''
    ? ` in the commit ${JSON.stringify(line)}`
    : '';
  return `the change${which} reads as breaking this taste (p=${noul.toFixed(2)})`;
}

async function ask(
  subject: Subject,
  question: string,
  apiKey: string,
  request: KindRequest,
): Promise<NoulAnswer> {
  const budget = budgetOf(request);
  const allowed = budget.grant(JUDGMENT_CALL_MS);
  const override = Number(request.env.TYPESAFE_TIMEOUT_MS);
  const started = Date.now();
  const answer = await askNoul({
    apiKey,
    baseUrl: request.env.TYPESAFE_BASE_URL,
    timeoutMs: Number.isFinite(override) && override > 0 ? Math.min(override, allowed) : allowed,
    state: { command: request.command, ...subject },
    instructions: { policy: request.body ?? '', question },
  });
  budget.spend(Date.now() - started);
  return answer;
}

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
  | { subjects: Subject[]; unread?: string }
  | { unchecked: string }
  | { skipped: string }
  | { out: true };

// Nothing to judge is not a judgment that found nothing. An amend is the
// exception: with nothing staged the new message is the whole of the change —
// and an amend that writes no message either is no evidence at all, so judging
// it would refuse on whatever the provider happened to return.
async function subjectOf(commit: Commit, request: KindRequest): Promise<
  { subject?: Subject } | { unchecked: string }
> {
  const dir = directoryOf(commit.options, commit.cwd);
  if (typeof dir !== 'string') return dir;

  const diff = await gitOutput(commit.all ? ['diff', 'HEAD'] : ['diff', '--cached'], request, dir);
  if ('unchecked' in diff) return diff;

  const message = cut(commit.message, MAX_MESSAGE_LENGTH, MESSAGE_CUT);
  if (diff.text.trim() === '') {
    if (!commit.amend || message.trim() === '') return {};
    return { subject: { message, diff: '' } };
  }
  return { subject: { message, diff: cut(diff.text, MAX_DIFF_LENGTH, DIFF_CUT) } };
}

// A chain writes more than one commit, and the taste binds each of them.
async function commitScope(request: KindRequest): Promise<Scope> {
  const found = commitIn(request.command, request.cwd);
  if (found === undefined) return { out: true };

  const subjects: Subject[] = [];
  for (const commit of found.commits) {
    const read = await subjectOf(commit, request);
    if ('unchecked' in read) return read;
    if (read.subject !== undefined) subjects.push(read.subject);
  }
  if (subjects.length > 0) return { subjects, unread: found.unread };
  return found.unread === undefined ? { out: true } : { unchecked: found.unread };
}

async function scopeOf(on: string, request: KindRequest): Promise<Scope> {
  if (on === 'any') return { subjects: [{ message: '', diff: '' }] };
  if (on === 'commit') return await commitScope(request);

  if (on === 'merge-request') {
    const opening = mergeRequestIn(request.command, request.cwd);
    if (opening === undefined) return { out: true };
    if (opening.hits.length === 0) return { unchecked: opening.unread as string };
    const diff = await mergeRequestDiff(request);
    if ('unchecked' in diff) return diff;
    const subject = { message: '', diff: cut(diff.text, MAX_DIFF_LENGTH, DIFF_CUT) };
    return { subjects: [subject], unread: opening.unread };
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

  // Reads the command and nothing else. An override may be honoured before the
  // check runs only where the check would have run at all, or an override
  // exported into a session becomes a notice on every command in it.
  applies(fields: Record<string, string>, command: string, cwd: string): boolean {
    const on = fields.on ?? 'commit';
    if (on === 'any') return true;
    if (on === 'merge-request') return mergeRequestIn(command, cwd) !== undefined;
    if (on !== 'commit') return false;
    return commitIn(command, cwd) !== undefined;
  },

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

    const threshold = parseThreshold(fields.threshold ?? '') ?? DEFAULT_THRESHOLD;
    const several = scope.subjects.length > 1;

    // One question per commit, out of the one budget the command has. The taste
    // fires on the first that breaks it: the refusal an agent reads names that
    // commit, and asking about the rest would not change the answer.
    for (const subject of scope.subjects) {
      // Asked of the budget before the provider: a call with nothing left to
      // spend would be a request sent to be abandoned.
      if (budgetOf(request).grant(JUDGMENT_CALL_MS) <= 0) {
        return { verdict: 'unchecked', detail: BUDGET_SPENT };
      }
      const answer = await ask(subject, question, apiKey, request);
      if (!answer.ok) {
        return {
          verdict: 'unchecked',
          detail: `the judgment provider did not answer — ${answer.reason}`,
        };
      }
      if (answer.noul >= threshold) {
        return {
          verdict: 'fires',
          finding: finding(subject, answer.noul, several),
          notice: scope.unread,
        };
      }
    }
    // Nothing that was read breaks the taste, but a part of the command was not
    // read at all, and that is not the same as a pass.
    if (scope.unread !== undefined) return { verdict: 'unchecked', detail: scope.unread };
    return { verdict: 'passes' };
  },
};
