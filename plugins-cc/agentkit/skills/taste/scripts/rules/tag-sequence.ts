import { runBounded } from '../run.ts';
import type { KindOutcome, KindRequest, RuleKind } from './kinds.ts';
import { matchErrors } from './pattern.ts';
import { compareVersions, parseVersion, sameCore, sameLine, type Version } from './semver.ts';
import { proposedTags } from './tag-command.ts';

// Long enough for a cold repository, short enough that a wedged git costs the
// session a moment rather than the hook's whole budget.
export const GIT_TIMEOUT_MS = 3000;

interface Tag {
  text: string;
  version: Version;
}

type Judge = (proposed: Tag, existing: Tag[]) => string | undefined;

function highestOf(tags: Tag[]): Tag | undefined {
  return tags.reduce<Tag | undefined>(
    (highest, tag) =>
      highest === undefined || compareVersions(tag.version, highest.version) > 0 ? tag : highest,
    undefined,
  );
}

function duplicate(proposed: Tag, existing: Tag[]): string | undefined {
  const clash = existing.find((tag) => compareVersions(tag.version, proposed.version) === 0);
  if (clash === undefined) return undefined;
  return clash.text === proposed.text
    ? `${proposed.text} already exists in this repository`
    : `${proposed.text} already exists as ${clash.text}`;
}

// A lower line is maintenance, not a mistake: what a tag may not do is go
// backwards among the tags it shares a major.minor with.
function backwardsInLine(proposed: Tag, existing: Tag[]): string | undefined {
  const line = existing.filter((tag) => sameLine(tag.version, proposed.version));
  const highest = highestOf(line);
  if (highest === undefined || compareVersions(highest.version, proposed.version) < 0) {
    return undefined;
  }
  return `${proposed.text} is behind ${highest.text}, the highest tag on the `
    + `${proposed.version.major}.${proposed.version.minor} line`;
}

function nextPatchOf(highest: Tag): string {
  const prefix = highest.text.startsWith('v') ? 'v' : '';
  const { major, minor, patch } = highest.version;
  return `${prefix}${major}.${minor}.${patch + 1}`;
}

// The immediate next patch of the highest tag overall — or the same core, which
// is how a prerelease reaches its release without the line restarting.
function notTheSuccessor(proposed: Tag, existing: Tag[]): string | undefined {
  const highest = highestOf(existing);
  if (highest === undefined) return undefined;
  if (compareVersions(proposed.version, highest.version) < 0) {
    return `${proposed.text} is not above ${highest.text}, the highest tag in this repository`;
  }
  const next = { ...highest.version, patch: highest.version.patch + 1, prerelease: [] };
  if (sameCore(proposed.version, highest.version) || sameCore(proposed.version, next)) {
    return undefined;
  }
  return `${proposed.text} is not the next patch after ${highest.text} — that would be `
    + nextPatchOf(highest);
}

const POLICIES: Record<string, Judge> = {
  'no-duplicate': duplicate,
  'no-backwards-in-line': (proposed, existing) =>
    duplicate(proposed, existing) ?? backwardsInLine(proposed, existing),
  'strict-successor': (proposed, existing) =>
    duplicate(proposed, existing) ?? notTheSuccessor(proposed, existing),
};

export const TAG_POLICIES: readonly string[] = Object.keys(POLICIES);

// A tag that is not semver carries no order, so no policy has anything to say
// about it — as a proposal or as one of the tags already there.
function knownTags(names: readonly string[]): Tag[] {
  const tags: Tag[] = [];
  for (const text of names) {
    const version = parseVersion(text);
    if (version !== undefined) tags.push({ text, version });
  }
  return tags;
}

export function judgeTag(
  policy: string,
  tag: string,
  existing: readonly string[],
): string | undefined {
  // Checked against the registered names rather than by looking the key up:
  // `constructor` and `toString` resolve to functions on any plain object, and
  // the hook's safety must not rest on the lint two modules away.
  const version = parseVersion(tag);
  if (!TAG_POLICIES.includes(policy) || version === undefined) return undefined;
  const judge = POLICIES[policy] as Judge;
  return judge({ text: tag, version }, knownTags(existing));
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? 'no output';
}

type Tags = { names: string[] } | { unchecked: string };

// The one failure that means "there is nothing here to check". Exit 128 alone
// does not: dubious ownership under a CI uid, a permission error and a corrupt
// repository all use it, and reading those as not-a-repository would delete the
// guard in exactly the environments that most need it.
// Both of git's discovery-failed phrasings, and neither of the ones it uses for
// a repository it found but could not use.
const NOT_A_REPOSITORY = /not a git repository \(or any /;

// git is asked in C, because the sentence above is what tells a directory with
// no repository apart from a repository that cannot be read, and a translated
// git would answer in another language.
function askedInC(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, LC_ALL: 'C', LANGUAGE: 'C', LANG: 'C' };
}

// Asymmetric on purpose, and the asymmetry is the design: a directory that is
// not a repository has no sequence to violate, so it passes silently; git that
// cannot answer is an unread guard, so it says UNCHECKED and still allows.
async function repositoryTags(
  cwd: string,
  callerEnv: Record<string, string | undefined>,
): Promise<Tags> {
  const env = askedInC(callerEnv);
  const inside = await runBounded(['git', '-C', cwd, 'rev-parse', '--git-dir'], cwd, env, GIT_TIMEOUT_MS);
  if (inside.code === null || inside.timedOut) {
    return { unchecked: `git could not be run in ${cwd} — ${firstLine(inside.err)}` };
  }
  if (!inside.ok) {
    if (NOT_A_REPOSITORY.test(inside.err)) return { names: [] };
    return { unchecked: `git could not read the repository at ${cwd} — ${firstLine(inside.err)}` };
  }

  const listed = await runBounded(['git', '-C', cwd, 'tag', '--list'], cwd, env, GIT_TIMEOUT_MS);
  if (!listed.ok) {
    return { unchecked: `git could not list the tags in ${cwd} — ${firstLine(listed.err)}` };
  }
  return { names: listed.out.split('\n').map((name) => name.trim()).filter((name) => name !== '') };
}

async function proposalsFor(
  fields: Record<string, string>,
  request: KindRequest,
): Promise<string[] | { skipped: string }> {
  const pattern = fields.match;
  if (pattern === undefined) return proposedTags(request.command);

  const outcome = await request.match(pattern, true);
  if ('skipped' in outcome) return outcome;
  return outcome.captures.filter((capture) => parseVersion(capture) !== undefined);
}

export const GIT_TAG_SEQUENCE: RuleKind = {
  name: 'git-tag-sequence',
  required: ['policy'],
  optional: ['match'],

  validate(fields: Record<string, string>): string[] {
    const errors: string[] = [];
    const policy = fields.policy;
    if (policy !== undefined && !TAG_POLICIES.includes(policy)) {
      errors.push(
        `rule.policy: ${JSON.stringify(policy)} is not one of ${TAG_POLICIES.join(', ')}`,
      );
    }
    if (fields.match !== undefined) errors.push(...matchErrors(fields.match));
    return errors;
  },

  async evaluate(fields: Record<string, string>, request: KindRequest): Promise<KindOutcome> {
    // The lint refuses a policy that is not registered, so reaching this means
    // the taste was never checked. Said out loud rather than allowed quietly,
    // for the same reason an unimplemented kind is.
    if (!TAG_POLICIES.includes(fields.policy as string)) {
      return {
        verdict: 'skipped',
        detail: `its rule.policy ${JSON.stringify(fields.policy ?? null)} is not one of `
          + TAG_POLICIES.join(', '),
      };
    }

    const proposals = await proposalsFor(fields, request);
    if (!Array.isArray(proposals)) return { verdict: 'skipped', detail: proposals.skipped };
    if (proposals.length === 0) return { verdict: 'passes' };

    const tags = await repositoryTags(request.cwd, request.env);
    if ('unchecked' in tags) return { verdict: 'unchecked', detail: tags.unchecked };
    if (tags.names.length === 0) return { verdict: 'passes' };

    for (const proposal of proposals) {
      const finding = judgeTag(fields.policy as string, proposal, tags.names);
      if (finding !== undefined) {
        return { verdict: 'fires', finding: `${finding}, and rule.policy is ${fields.policy}` };
      }
    }
    return { verdict: 'passes' };
  },
};
