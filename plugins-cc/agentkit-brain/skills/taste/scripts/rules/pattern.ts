// A rule is tested in-process against every command an agent runs, and a
// regular expression can be made to backtrack for longer than anyone will wait.
// The subject is bounded where the matching happens (police.ts); the pattern is
// bounded here, so an unrunnable rule fails the lint rather than a session.
export const MAX_MATCH_LENGTH = 200;

const SHELL_SUBSTITUTION = /\$\(|`/;

// Every kind that reads a pattern out of a taste holds it to the same bounds:
// a second kind's `match` is the same string in the same file, evaluated by the
// same worker, so a looser one would be a way around the first.
export function matchErrors(pattern: string): string[] {
  const errors: string[] = [];
  if (pattern.length > MAX_MATCH_LENGTH) {
    errors.push(
      `rule.match is ${pattern.length} characters — the cap is ${MAX_MATCH_LENGTH}, because `
        + 'the hook runs it against every command. Narrow the pattern, or keep the taste at check.',
    );
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    errors.push(`rule.match is not a valid regular expression: ${(error as Error).message}`);
  }
  if (SHELL_SUBSTITUTION.test(pattern)) {
    errors.push(
      'rule.match carries a command substitution — a rule is data; escape it as \\$\\( to '
        + 'match those characters literally. A backtick cannot appear in a match at all.',
    );
  }
  return errors;
}

export function carriesSubstitution(value: string): boolean {
  return SHELL_SUBSTITUTION.test(value);
}
