import { unquote } from '../override.ts';
import { parseVersion } from './semver.ts';

// Quoted and escaped runs are one token: a separator inside a tag message must
// not end the command and hide the tag after it, and a quote may open partway
// through a word — `-m"a;b"` is one argument to git.
// The double-quoted arm is unrolled rather than `(?:\\.|[^"\\])*`, which matches
// the same language but backtracks through every position of an unterminated
// quote — and this runs in the hook's own process, with no deadline around it.
const TOKEN = /(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\\.|[^\s;&|"'\\]+)+|[;&|\n]+/g;
const SEPARATOR = /^[;&|\n]+$/;
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

const GIT_GLOBAL_VALUED = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'];
const GH_GLOBAL_VALUED = ['-R', '--repo'];

function segments(command: string): string[][] {
  const found: string[][] = [[]];
  for (const token of command.match(TOKEN) ?? []) {
    if (SEPARATOR.test(token)) {
      found.push([]);
      continue;
    }
    (found[found.length - 1] as string[]).push(unquote(token));
  }
  return found;
}

function named(word: string, program: string): boolean {
  return word === program || word.endsWith(`/${program}`);
}

function dropOptions(words: string[], valued: readonly string[]): void {
  while (words.length > 0 && (words[0] as string).startsWith('-')) {
    const option = words.shift() as string;
    if (valued.includes(option)) words.shift();
  }
}

interface Reading {
  shape: Shape;
  words: string[];
}

function readingOf(segment: string[]): Reading | undefined {
  const words = [...segment];
  while (words.length > 0 && ASSIGNMENT.test(words[0] as string)) words.shift();
  const program = words.shift();
  if (program === undefined) return undefined;

  if (named(program, 'git')) {
    dropOptions(words, GIT_GLOBAL_VALUED);
    const subcommand = words.shift();
    if (subcommand === 'tag') return { shape: GIT_TAG, words };
    if (subcommand === 'push') return { shape: GIT_PUSH, words };
    return undefined;
  }

  if (named(program, 'gh')) {
    dropOptions(words, GH_GLOBAL_VALUED);
    if (words.shift() !== 'release') return undefined;
    if (words.shift() !== 'create') return undefined;
    return { shape: GH_RELEASE_CREATE, words };
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
  for (const segment of segments(command)) {
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
