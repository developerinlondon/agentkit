import { afterEach, describe, expect, test } from 'bun:test';
import { lintTasteDirectory } from '../../skills/taste/scripts/lint.ts';
import {
  evaluateRule,
  type KindRequest,
  type MatchOutcome,
  RULE_KINDS,
  ruleKeys,
  ruleKind,
} from '../../skills/taste/scripts/rules/kinds.ts';
import { removeScratch, scratch } from './fixtures.ts';

afterEach(removeScratch);

const BODY = 'Cut the next patch.\n\nWhy: a tag is a promise.\n\nHow to apply: read the tags first.';

// The rule block is the only thing that varies here, so the taste around it is
// the smallest one the lint accepts at enforce: block.
function blocking(rule: string): Record<string, string> {
  const front = [
    'name: release-tier',
    'scope: project',
    'strength: require',
    'enforce: block',
    'provenance: 2026-08-05 · session correction',
    `rule:\n${rule}`,
  ].join('\n');
  return { 'release-tier.md': `---\n${front}\n---\n\n${BODY}\n` };
}

function request(command = 'git tag v1.0.0', match?: () => Promise<MatchOutcome>): KindRequest {
  return {
    command,
    cwd: scratch(),
    env: {},
    match: (match ?? (async () => ({ matched: false, captures: [] }))) as KindRequest['match'],
  };
}

describe('the registry is what a kind name resolves to', () => {
  test('both kinds agentkit implements are registered', () => {
    expect(RULE_KINDS).toEqual(['command', 'git-tag-sequence']);
  });

  test('a kind declares the fields the lint reads', () => {
    const command = ruleKind('command');
    expect(command?.required).toEqual(['match']);
    expect(ruleKeys(command as NonNullable<typeof command>)).toEqual([
      'kind',
      'match',
      'remedy',
      'override',
    ]);
  });

  test('an unregistered name resolves to nothing rather than a default kind', () => {
    expect(ruleKind('git-tag-sequenc')).toBeUndefined();
    expect(ruleKind('')).toBeUndefined();
  });
});

describe('a kind this agentkit does not implement', () => {
  // The version-skew case: a taste vendored from a source whose agentkit is
  // newer. The hook must survive it, and must say that it did not enforce it.
  test('is skipped by the hook, loudly, rather than crashing it', async () => {
    const outcome = await evaluateRule('git-worktree-shape', { policy: 'whatever' }, request());
    const detail = outcome.verdict === 'skipped' ? outcome.detail : '';

    expect(outcome.verdict).toBe('skipped');
    expect(detail).toContain('git-worktree-shape');
    expect(detail).toContain('not implemented');
    for (const kind of RULE_KINDS) expect(detail).toContain(kind);
  });

  test('is refused by the lint, naming the kinds that do exist', () => {
    const dir = scratch(blocking(
      '  kind: git-worktree-shape\n  policy: whatever\n  remedy: Do it another way.',
    ));
    const errors = lintTasteDirectory(dir);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.kind');
    for (const kind of RULE_KINDS) expect(errors[0]).toContain(kind);
  });

  test('a registered kind still reaches its own evaluator', async () => {
    const matched = async () => ({ matched: true, captures: [] });
    const outcome = await evaluateRule(
      'command',
      { match: 'git tag' },
      request('git tag v1.0.0', matched),
    );

    expect(outcome.verdict).toBe('fires');
  });
});

describe('the lint reads each kind\'s own vocabulary', () => {
  test('a field one kind requires is unknown to the other', () => {
    const dir = scratch(blocking(
      "  kind: command\n  match: 'git tag'\n  policy: no-duplicate\n  remedy: Cut a patch tag.",
    ));
    const errors = lintTasteDirectory(dir);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown rule key: policy');
    expect(errors[0]).toContain('kind command carries');
  });

  test('a tag-sequence rule needs no match, and is accepted without one', () => {
    const dir = scratch(blocking(
      '  kind: git-tag-sequence\n  policy: no-backwards-in-line\n  remedy: Cut the next patch.',
    ));

    expect(lintTasteDirectory(dir)).toEqual([]);
  });

  test('a tag-sequence rule missing its policy is refused', () => {
    const dir = scratch(blocking('  kind: git-tag-sequence\n  remedy: Cut the next patch.'));
    const errors = lintTasteDirectory(dir);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.policy');
  });

  test('a command rule missing its match is refused the same way', () => {
    const dir = scratch(blocking('  kind: command\n  remedy: Cut a patch tag.'));
    const errors = lintTasteDirectory(dir);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule.match');
  });
});
