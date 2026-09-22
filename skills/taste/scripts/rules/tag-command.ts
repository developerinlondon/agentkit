import { unquote } from '../override.ts';
import { parseVersion } from './semver.ts';

// Quoted and escaped runs are one token: a separator inside a tag message must
// not end the command and hide the tag after it, and a quote may open partway
// through a word — `-m"a;b"` is one argument to git.
// The double-quoted arm is unrolled rather than `(?:\\.|[^"\\])*`, which matches
// the same language but backtracks through every position of an unterminated
// quote — and this runs in the hook's own process, with no deadline around it.
// A parenthesis separates as firmly as a semicolon: `(git commit …)` and
// `(cd sub && git tag …)` are commands an agent writes, and reading `(git` as a
// program name is how a subshell hides one from every check here.
const TOKEN = /(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\\.|[^\s;&|()"'\\]+)+|[;&|()\n]+/g;
const SEPARATOR = /^[;&|()\n]+$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Shape {
  // An option that means this command lists, verifies or removes a tag rather
  // than proposing one. Its presence ends the reading.
  skip: readonly string[];
  // An option whose value is the next word, which is therefore not a tag.
  valued: readonly string[];
  // git push names the remote first; only what follows it is a refspec.
  dropFirst: boolean;
}

const GIT_TAG: Shape = {
  skip: [
    '-d',
    '--delete',
    '-l',
    '--list',
    '-v',
    '--verify',
    '-n',
    '--contains',
    '--no-contains',
    '--points-at',
    '--merged',
    '--no-merged',
    '--column',
  ],
  valued: ['-m', '--message', '-F', '--file', '-u', '--local-user', '--sort', '--format', '--cleanup'],
  dropFirst: false,
};

const GIT_PUSH: Shape = {
  skip: ['-d', '--delete', '--prune', '--mirror'],
  valued: ['--repo', '-o', '--push-option', '--receive-pack', '--exec'],
  dropFirst: true,
};

const GH_RELEASE_CREATE: Shape = {
  skip: [],
  valued: [
    '-t',
    '--title',
    '-n',
    '--notes',
    '-F',
    '--notes-file',
    '--target',
    '--discussion-category',
    '-R',
    '--repo',
    '--notes-start-tag',
  ],
  dropFirst: false,
};

export const GIT_GLOBAL_VALUED =
  ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'];
export const FORGE_GLOBAL_VALUED = ['-R', '--repo'];

// A parenthesis is kept as a segment of its own rather than dropped with the
// other separators: a subshell is a scope, and a caller tracking where a
// command runs has to see where one opens and closes.
export const SUBSHELL_OPEN = '(';
export const SUBSHELL_CLOSE = ')';

// A segment with the text it came from still attached. Quoting is how an owner
// writes a pattern — `-m 'wip'` — so a caller that has to hand a taste part of
// a command cuts that part out of the original rather than spelling it again.
export interface Piece {
  words: string[];
  spans: { start: number; end: number }[];
  // The string the spans index into: the command, or a wrapper's own argument.
  source: string;
}

export function commandPieces(command: string): Piece[] {
  const found: Piece[] = [{ words: [], spans: [], source: command }];
  const open = () => {
    found.push({ words: [], spans: [], source: command });
    return found[found.length - 1] as Piece;
  };

  for (const match of command.matchAll(TOKEN)) {
    const token = match[0];
    const at = match.index;
    if (!SEPARATOR.test(token)) {
      const piece = found[found.length - 1] as Piece;
      piece.words.push(unquote(token));
      piece.spans.push({ start: at, end: at + token.length });
      continue;
    }
    for (let index = 0; index < token.length; index += 1) {
      const char = token[index] as string;
      if (char !== SUBSHELL_OPEN && char !== SUBSHELL_CLOSE) continue;
      const marker = open();
      marker.words.push(char);
      marker.spans.push({ start: at + index, end: at + index + 1 });
    }
    open();
  }
  return found;
}

export function commandSegments(command: string): string[][] {
  return commandPieces(command).map((piece) => piece.words);
}

function named(word: string, program: string): boolean {
  return word === program || word.endsWith(`/${program}`);
}

interface Reading {
  shape: Shape;
  words: string[];
}

// The words a program was invoked with, or nothing when this segment invokes
// something else. An inline assignment prefix and the program's own global
// options are dropped, so what is left starts at the subcommand.
export interface Invocation {
  // The global options that came before the subcommand, values included. What
  // they say about where the command runs is the caller's business.
  options: string[];
  words: string[];
}

export function programInvocation(
  segment: readonly string[],
  program: string,
  valued: readonly string[] = [],
): Invocation | undefined {
  const words = [...segment];
  while (words.length > 0 && ASSIGNMENT.test(words[0] as string)) words.shift();
  const invoked = words.shift();
  if (invoked === undefined || !named(invoked, program)) return undefined;

  const options: string[] = [];
  while (words.length > 0 && (words[0] as string).startsWith('-')) {
    const option = words.shift() as string;
    options.push(option);
    if (valued.includes(option) && words.length > 0) options.push(words.shift() as string);
  }
  return { options, words };
}

export function programWords(
  segment: readonly string[],
  program: string,
  valued: readonly string[] = [],
): string[] | undefined {
  return programInvocation(segment, program, valued)?.words;
}

// The first word a segment runs, with any inline assignment prefix dropped.
export function programOf(segment: readonly string[]): string | undefined {
  const words = [...segment];
  while (words.length > 0 && ASSIGNMENT.test(words[0] as string)) words.shift();
  return words[0];
}

function readingOf(segment: string[]): Reading | undefined {
  const git = programWords(segment, 'git', GIT_GLOBAL_VALUED);
  if (git !== undefined) {
    const subcommand = git.shift();
    if (subcommand === 'tag') return { shape: GIT_TAG, words: git };
    if (subcommand === 'push') return { shape: GIT_PUSH, words: git };
    return undefined;
  }

  const gh = programWords(segment, 'gh', FORGE_GLOBAL_VALUED);
  if (gh !== undefined) {
    if (gh.shift() !== 'release') return undefined;
    if (gh.shift() !== 'create') return undefined;
    return { shape: GH_RELEASE_CREATE, words: gh };
  }

  return undefined;
}

function positionals(reading: Reading): string[] | undefined {
  const found: string[] = [];
  const words = reading.words;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--') {
      found.push(...words.slice(index + 1));
      break;
    }
    if (word.startsWith('-') && word.length > 1) {
      const option = word.split('=')[0] as string;
      if (reading.shape.skip.includes(option)) return undefined;
      if (reading.shape.valued.includes(option) && !word.includes('=')) index += 1;
      continue;
    }
    found.push(word);
  }
  return reading.shape.dropFirst ? found.slice(1) : found;
}

function refName(word: string): string {
  const target = word.replace(/^\+/, '').split(':').pop() as string;
  return target.replace(/^refs\/tags\//, '');
}

// Every version-shaped tag this command would create, in the shapes agentkit
// recognises. Anything that is not semver is not a tag this can reason about,
// so it never becomes a proposal.
export function proposedTags(command: string): string[] {
  const tags: string[] = [];
  for (const segment of commandSegments(command)) {
    const reading = readingOf(segment);
    if (reading === undefined) continue;
    const words = positionals(reading);
    if (words === undefined) continue;
    for (const word of words) {
      const tag = refName(word);
      if (parseVersion(tag) !== undefined && !tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}
