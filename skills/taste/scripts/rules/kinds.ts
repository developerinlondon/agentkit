import { matchErrors } from './pattern.ts';
import { GIT_TAG_SEQUENCE } from './tag-sequence.ts';

export type MatchOutcome = { matched: boolean; captures: string[] } | { skipped: string };

// The bounded matcher, supplied by whoever is running the rule. A kind never
// compiles a taste's pattern itself: the deadline that makes a hostile pattern
// survivable lives in one place, and every kind borrows it.
export type Matcher = (pattern: string, capture?: boolean) => Promise<MatchOutcome>;

export interface KindRequest {
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  match: Matcher;
}

// `fires` refuses and says what was found; `skipped` and `unchecked` both allow
// and both say so. They are separate because they answer different questions:
// skipped means this taste could not be applied, unchecked means the state the
// check needed could not be read.
export type KindOutcome =
  | { verdict: 'fires'; finding: string }
  | { verdict: 'passes' }
  | { verdict: 'skipped'; detail: string }
  | { verdict: 'unchecked'; detail: string };

// One entry per enforcement vocabulary agentkit implements. A taste names the
// kind and parameterises it; the code is always agentkit's, which is what keeps
// a taste data rather than a program.
export interface RuleKind {
  name: string;
  // Beyond `kind`, `remedy` and `override`, which every kind carries.
  required: readonly string[];
  optional: readonly string[];
  validate(fields: Record<string, string>): string[];
  evaluate(fields: Record<string, string>, request: KindRequest): Promise<KindOutcome>;
}

const COMMAND: RuleKind = {
  name: 'command',
  required: ['match'],
  optional: [],
  validate(fields: Record<string, string>): string[] {
    return fields.match === undefined ? [] : matchErrors(fields.match);
  },
  async evaluate(fields: Record<string, string>, request: KindRequest): Promise<KindOutcome> {
    const outcome = await request.match(fields.match as string);
    if ('skipped' in outcome) return { verdict: 'skipped', detail: outcome.skipped };
    return outcome.matched
      ? { verdict: 'fires', finding: 'this command matches rule.match' }
      : { verdict: 'passes' };
  },
};

const KINDS: readonly RuleKind[] = [COMMAND, GIT_TAG_SEQUENCE];

export const RULE_KINDS: readonly string[] = KINDS.map((kind) => kind.name);

export function ruleKind(name: string): RuleKind | undefined {
  return KINDS.find((kind) => kind.name === name);
}

// What the lint accepts inside a rule of this kind, in reading order: what it
// is, what it needs, what it may have, what it says, and how to get past it.
export function ruleKeys(kind: RuleKind): string[] {
  return ['kind', ...kind.required, ...kind.optional, 'remedy', 'override'];
}

// A taste written against a newer agentkit names a kind this one has never
// heard of. It is skipped and said out loud — never a throw, because one taste
// from the future must not take the whole hook down with it, and never silence,
// because an enforcement that stopped happening has to be visible.
export async function evaluateRule(
  name: string,
  fields: Record<string, string>,
  request: KindRequest,
): Promise<KindOutcome> {
  const kind = ruleKind(name);
  if (kind === undefined) {
    return {
      verdict: 'skipped',
      detail: `its rule.kind ${JSON.stringify(name)} is not implemented by this version of `
        + `agentkit, which has ${RULE_KINDS.join(', ')}. Upgrade agentkit, or keep the taste at `
        + 'enforce: check',
    };
  }
  return await kind.evaluate(fields, request);
}
