import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { unquote } from '../override.ts';
import { runBounded } from '../run.ts';
import { type Budget, BUDGET_SPENT, JUDGMENT_CALL_MS, judgmentBudget } from './budget.ts';
import type { KindOutcome, KindRequest, RuleKind } from './kinds.ts';
import { carriesSubstitution } from './pattern.ts';
import { askNoul, type NoulAnswer } from './providers/typesafe.ts';
import {
  commandSegments,
  FORGE_GLOBAL_VALUED,
  GIT_GLOBAL_VALUED,
  programInvocation,
  programOf,
  programWords,
  SUBSHELL_CLOSE,
  SUBSHELL_OPEN,
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
const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh'];
// What a shell would turn into something else before running it. Their absence
// is what makes a wrapped command readable as written.
const EXPANDS = /[$`]/;
const DASH_C = /^-[a-zA-Z]*c[a-zA-Z]*$/;
// A wrapper inside a wrapper is legitimate and rare; deeper than this is a
// generated command, and reading one confidently is not on offer.
export const MAX_WRAPPER_DEPTH = 3;
// A quote the tokeniser cannot resolve. It strips one surrounding pair and
// never unescapes, so an escaped quote inside a quoted run reads as text it is
// not, and a quote that never closes ends the reading early — and both look
// exactly like a command that holds no commit.
const NESTED_QUOTE = /\\["']/;

// A path this check may resolve itself: spelled out in the command, with
// nothing for a shell to expand into something else.
const LITERAL_PATH = /^[^$`*?~\[\]{}!]+$/;

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

type Found = { commits: Commit[] } | { unchecked: string } | undefined;

// A program whose job is to run another one. It is not the command; what it
// launches is, so a commit or a shell behind one is read exactly as it would be
// in front. Anything not on this list is a program that might do anything, and
// what it runs stays out of sight.
interface Launcher {
  name: string;
  // Options of the launcher's own that take the next word.
  valued: readonly string[];
  // Bare words belonging to the launcher rather than to what it runs.
  positionals: number;
}

const LAUNCHERS: readonly Launcher[] = [
  { name: 'env', valued: ['-u', '--unset', '-C', '--chdir'], positionals: 0 },
  { name: 'timeout', valued: ['-k', '--kill-after', '-s', '--signal'], positionals: 1 },
  { name: 'nohup', valued: [], positionals: 0 },
  { name: 'sudo', valued: ['-u', '--user', '-g', '--group', '-p', '--prompt'], positionals: 0 },
  { name: 'nice', valued: ['-n', '--adjustment'], positionals: 0 },
  {
    name: 'xargs',
    valued: ['-n', '-P', '-I', '-d', '-E', '-L', '-s'],
    positionals: 0,
    assignments: false,
  },
];

// Found by name rather than by key lookup: `constructor` resolves on any plain
// object, and what a launcher may hide must not rest on that.
function launcherOf(program: string): Launcher | undefined {
  return LAUNCHERS.find((one) => program === one.name || program.endsWith(`/${one.name}`));
}

function launched(segment: readonly string[], depth = 0): readonly string[] {
  const program = programOf(segment);
  if (program === undefined || depth > LAUNCHERS.length) return segment;
  const launcher = launcherOf(program);
  if (launcher === undefined) return segment;

  const invocation = programInvocation(segment, launcher.name, launcher.valued);
  if (invocation === undefined) return segment;
  // An inline assignment between a launcher and its command is dropped by the
  // invocation reader on the next pass, so `env FOO=1 bash -c …` needs nothing
  // of its own here.
  const rest = invocation.words.slice(launcher.positionals);
  return rest.length === 0 ? segment : launched(rest, depth + 1);
}

// The text a wrapper would run, and the name to say if it cannot be read.
function wrapped(segment: readonly string[]): { name: string; text: string } | undefined {
  const evaluated = programInvocation(segment, 'eval');
  if (evaluated !== undefined) {
    return { name: 'eval', text: [...evaluated.options, ...evaluated.words].join(' ') };
  }

  for (const shell of SHELLS) {
    const invocation = programInvocation(segment, shell);
    if (invocation === undefined) continue;
    const words = [...invocation.options, ...invocation.words];
    const at = words.findIndex((word) => DASH_C.test(word) || word === '--command');
    // A shell without -c runs a file, which is not a command this can read
    // either — but it is also not one this can see a commit in.
    if (at === -1) return undefined;
    return { name: `${shell} -c`, text: words[at + 1] ?? '' };
  }
  return undefined;
}

// Quoting the tokeniser cannot resolve, read the way a shell reads it. A quote
// inside a run of the other kind is an ordinary character, which is why
// `'echo "hi"'` is fine while `'it'"'"'s'` is not: the second closes a run and
// opens another with nothing between, and the tokeniser reads one pair and
// stops. Backslashes are not tracked here; an escaped quote is refused before
// this runs.
function quoteTrouble(text: string): string | undefined {
  let open: string | undefined;
  let justClosed = false;

  for (const char of text) {
    if (open === undefined) {
      if (char !== "'" && char !== '"') {
        justClosed = false;
        continue;
      }
      if (justClosed) return 'quoting concatenated out of separate runs';
      open = char;
      justClosed = false;
      continue;
    }
    justClosed = char === open;
    if (justClosed) open = undefined;
  }

  return open === undefined ? undefined : 'quoting that never closes';
}

// Said only of a command that runs a shell wrapper, because that is where
// quoting this cannot resolve hides a whole command rather than mangling one
// argument of a command already in view. A wrapper's name inside a message is
// a word, and a word is not worth refusing a commit over.
function runsAWrapper(segments: readonly string[][]): boolean {
  return segments.some((segment) => {
    const program = programOf(launched(segment));
    if (program === undefined) return false;
    return ['eval', ...SHELLS].some((name) =>
      program === name || program.endsWith(`/${name}`)
    );
  });
}

function unreadableQuoting(command: string, segments: readonly string[][]): string | undefined {
  if (!runsAWrapper(segments)) return undefined;
  if (NESTED_QUOTE.test(command)) return 'an escaped quote inside a quoted run';
  return quoteTrouble(command);
}

// Where a `cd` names its destination outright, reading it is not a guess; the
// tree the commit applies to is in the command. Anything a shell would expand
// stays unreadable, and so does `pushd`, whose later `popd` moves it back.
function movedBy(
  segment: readonly string[],
  program: string,
  dir: string,
): string | { unchecked: string } {
  const args = segment.slice(segment.indexOf(program) + 1);
  const target = args[0];
  if (
    program !== 'cd' || args.length !== 1 || target === undefined || !LITERAL_PATH.test(target)
  ) {
    return {
      unchecked: 'the command changes directory before committing in a way this check cannot '
        + 'read, so the repository it commits in is not the one this check would look at',
    };
  }
  return isAbsolute(target) ? target : resolve(dir, target);
}

type Hit<T> = { hits: T[] } | { unchecked: string };

interface Frame {
  dir: string;
  blocked: string | undefined;
}

// One walk for every shape that asks "does this command do X, and where". A
// subshell and a wrapper are both scopes: a `cd` inside one moves what that
// scope's own commands see and nothing after it, which is why the walk carries
// a stack instead of flattening everything into one list.
function walk<T>(
  segments: readonly string[][],
  cwd: string,
  depth: number,
  look: (segment: readonly string[], dir: string) => T | undefined,
  // Carried in from the scope that opened this one: a directory change this
  // could not read still binds whatever runs after it, and a wrapper is not a
  // way out of that.
  from?: string,
): Hit<T> {
  const frames: Frame[] = [];
  const hits: T[] = [];
  let dir = cwd;
  let blocked: string | undefined = from;

  for (const raw of segments) {
    const segment = launched(raw);
    if (segment.length === 1 && segment[0] === SUBSHELL_OPEN) {
      frames.push({ dir, blocked });
      continue;
    }
    if (segment.length === 1 && segment[0] === SUBSHELL_CLOSE) {
      const left = frames.pop();
      if (left !== undefined) {
        dir = left.dir;
        blocked = left.blocked;
      }
      continue;
    }

    const inner = wrapped(segment);
    if (inner !== undefined) {
      if (depth + 1 > MAX_WRAPPER_DEPTH) {
        return {
          unchecked: `the command nests wrappers more than ${MAX_WRAPPER_DEPTH} deep, so what `
            + 'finally runs is not something this check can read',
        };
      }
      if (EXPANDS.test(inner.text)) {
        return {
          unchecked: `the command runs through ${inner.name} on text built at run time, so `
            + 'whether it commits, and what it commits, is not something this check can read',
        };
      }
      const found = walk(commandSegments(inner.text), dir, depth + 1, look, blocked);
      if ('unchecked' in found) return found;
      hits.push(...found.hits);
      continue;
    }

    const program = programOf(segment);
    if (program !== undefined && CHANGES_DIRECTORY.includes(program)) {
      const moved = movedBy(segment, program, dir);
      if (typeof moved === 'string') dir = moved;
      else blocked = moved.unchecked;
      continue;
    }

    const hit = look(segment, dir);
    if (hit === undefined) continue;
    // A command this could not follow makes every commit after it unreadable,
    // so the first one reached under a block ends the walk rather than joining
    // a list that would be judged against the wrong tree.
    if (blocked !== undefined) return { unchecked: blocked };
    hits.push(hit);
  }
  return { hits };
}

function commitAt(segment: readonly string[], dir: string): Commit | undefined {
  const invocation = programInvocation(segment, 'git', GIT_GLOBAL_VALUED);
  if (invocation === undefined || invocation.words[0] !== 'commit') return undefined;
  return readCommit(invocation.words.slice(1), invocation.options, dir);
}

function commitIn(command: string, cwd: string): Found {
  const segments = commandSegments(command);
  const quoting = unreadableQuoting(command, segments);
  if (quoting !== undefined) {
    return {
      unchecked: `the command carries ${quoting}, so whether it commits, and what it commits, `
        + 'is not something this check can read',
    };
  }
  const found = walk(segments, cwd, 0, commitAt);
  if ('unchecked' in found) return found;
  return found.hits.length === 0 ? undefined : { commits: found.hits };
}

// -C is where git runs; --git-dir and --work-tree take it apart, and a diff
// read from either half on its own is not the change being committed.
function repositoryOf(commit: Commit): string | { unchecked: string } {
  let dir = commit.cwd;
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
      unchecked: `the command carries ${quoting}, so whether it opens a merge request is not `
        + 'something this check can read',
    };
  }
  const found = walk(segments, cwd, 0, openingAt);
  if ('unchecked' in found) return found;
  return found.hits.length === 0 ? undefined : found;
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
  | { subjects: Subject[] }
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
  const dir = repositoryOf(commit);
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
  if ('unchecked' in found) return found;

  const subjects: Subject[] = [];
  for (const commit of found.commits) {
    const read = await subjectOf(commit, request);
    if ('unchecked' in read) return read;
    if (read.subject !== undefined) subjects.push(read.subject);
  }
  return subjects.length === 0 ? { out: true } : { subjects };
}

async function scopeOf(on: string, request: KindRequest): Promise<Scope> {
  if (on === 'any') return { subjects: [{ message: '', diff: '' }] };
  if (on === 'commit') return await commitScope(request);

  if (on === 'merge-request') {
    const opening = mergeRequestIn(request.command, request.cwd);
    if (opening === undefined) return { out: true };
    if ('unchecked' in opening) return opening;
    const diff = await mergeRequestDiff(request);
    if ('unchecked' in diff) return diff;
    return { subjects: [{ message: '', diff: cut(diff.text, MAX_DIFF_LENGTH, DIFF_CUT) }] };
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
        return { verdict: 'fires', finding: finding(subject, answer.noul, several) };
      }
    }
    return { verdict: 'passes' };
  },
};
