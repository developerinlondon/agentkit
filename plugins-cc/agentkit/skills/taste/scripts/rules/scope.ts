import { isAbsolute, resolve } from 'node:path';
import {
  commandSegments,
  GIT_GLOBAL_VALUED,
  programInvocation,
  programOf,
  SUBSHELL_CLOSE,
  SUBSHELL_OPEN,
} from './tag-command.ts';

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

// The programs whose repository has tastes of its own worth loading. Used only
// to decide whether a directory this could not read was worth reporting.
const REPOSITORY_PROGRAMS = ['git', 'gh', 'glab'];

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
  { name: 'xargs', valued: ['-n', '-P', '-I', '-d', '-E', '-L', '-s'], positionals: 0 },
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

export function unreadableQuoting(
  command: string,
  segments: readonly string[][],
): string | undefined {
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

export interface Hit<T> {
  hits: T[];
  unread?: string;
}

interface Frame {
  dir: string;
  blocked: string | undefined;
}

// One walk for every shape that asks "does this command do X, and where". A
// subshell and a wrapper are both scopes: a `cd` inside one moves what that
// scope's own commands see and nothing after it, which is why the walk carries
// a stack instead of flattening everything into one list.
export function walk<T>(
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
          hits,
          unread: `the command nests wrappers more than ${MAX_WRAPPER_DEPTH} deep, so what `
            + 'finally runs is not something this check can read',
        };
      }
      if (EXPANDS.test(inner.text)) {
        return {
          hits,
          unread: `the command runs through ${inner.name} on text built at run time, so `
            + 'whether it commits, and what it commits, is not something this check can read',
        };
      }
      const found = walk(commandSegments(inner.text), dir, depth + 1, look, blocked);
      hits.push(...found.hits);
      if (found.unread !== undefined) return { hits, unread: found.unread };
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
    // A command this could not follow makes everything after it unreadable, so
    // the first hit reached under a block ends the walk — but what was read
    // before the block was read correctly, and is carried out with it.
    if (blocked !== undefined) return { hits, unread: blocked };
    hits.push(hit);
  }
  return { hits };
}

// -C is where git runs; --git-dir and --work-tree take it apart, and a tree
// read from either half on its own is not the one the command acts in.
export function directoryOf(
  options: readonly string[],
  cwd: string,
): string | { unchecked: string } {
  let dir = cwd;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index] as string;
    const name = option.split('=')[0] as string;
    if (name === '--git-dir' || name === '--work-tree') {
      return {
        unchecked: `the command names its own ${name}, so the tree it applies to is not one this `
          + 'check can read',
      };
    }
    if (option === '-C') {
      const value = options[index + 1];
      if (value !== undefined) dir = isAbsolute(value) ? value : resolve(dir, value);
      index += 1;
    }
  }
  return dir;
}

function actsIn(segment: readonly string[], dir: string): string | undefined {
  const git = programInvocation(segment, 'git', GIT_GLOBAL_VALUED);
  if (git === undefined) return dir;
  const named = directoryOf(git.options, dir);
  return typeof named === 'string' ? named : undefined;
}

function reachesARepository(segment: readonly string[], dir: string): string | undefined {
  const program = programOf(segment);
  if (program === undefined) return undefined;
  const repository = REPOSITORY_PROGRAMS.some((name) =>
    program === name || program.endsWith(`/${name}`)
  );
  return repository ? dir : undefined;
}

export interface Acted {
  // Every directory the command acts in other than the one it starts in,
  // in the order it reaches them and without repeats.
  dirs: string[];
  // A directory change this could not follow, said only where a repository
  // command runs after it — anywhere else there were no tastes to miss.
  unread?: string;
}

// Where a command acts, read from its text alone. What a caller does with the
// answer is its own business: the taste hook loads each directory's project
// tastes, and a kind asks its own question of each.
export function actedDirectories(command: string, cwd: string): Acted {
  const segments = commandSegments(command);
  const quoting = unreadableQuoting(command, segments);
  if (quoting !== undefined) return { dirs: [], unread: quoting };

  const acted = walk(segments, cwd, 0, actsIn);
  const dirs: string[] = [];
  for (const dir of acted.hits) {
    if (dir !== cwd && !dirs.includes(dir)) dirs.push(dir);
  }

  // Asked separately, because the walk stops at the first thing it finds under
  // a block: what matters is not that something ran somewhere unreadable, but
  // that a repository command did.
  const reached = walk(segments, cwd, 0, reachesARepository);
  return reached.unread === undefined ? { dirs } : { dirs, unread: reached.unread };
}
