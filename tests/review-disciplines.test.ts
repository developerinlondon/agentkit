import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(import.meta.dir, '..', 'skills');
const instructionsDir = join(import.meta.dir, '..', 'instructions');
const autonomousWorkflow = readFileSync(join(skillsDir, 'autonomous-workflow', 'SKILL.md'), 'utf-8');
const productReview = readFileSync(join(skillsDir, 'product-review', 'SKILL.md'), 'utf-8');
const adversarialReview = readFileSync(join(skillsDir, 'adversarial-review', 'SKILL.md'), 'utf-8');
const reviewerDispatch = readFileSync(
  join(skillsDir, 'adversarial-review', 'references', 'reviewer-dispatch.md'),
  'utf-8',
);
const resourceSafeExecution = readFileSync(
  join(skillsDir, 'resource-safe-execution', 'SKILL.md'),
  'utf-8',
);
const codingDiscipline = readFileSync(join(instructionsDir, 'coding-discipline.md'), 'utf-8');
const evidenceGatedReview = readFileSync(
  join(instructionsDir, 'evidence-gated-review.md'),
  'utf-8',
);
const testDrivenDevelopment = readFileSync(
  join(skillsDir, 'test-driven-development', 'SKILL.md'),
  'utf-8',
);

describe('review disciplines', () => {
  test('keeps evidence checks in the review workflow', () => {
    expect(autonomousWorkflow).toContain('Audit the claims, not just the logic');
    expect(autonomousWorkflow).toContain('Observe External Behaviour Before Building On It');
    expect(productReview).toContain('Observed vs inferred');
    expect(adversarialReview).toContain('Trace before reading the maker narrative');
    expect(adversarialReview).toContain('concrete failing input or a replayable trace');
    expect(evidenceGatedReview).toContain('Evidence-Gated Review');
    expect(evidenceGatedReview).toMatch(/policy from the exact target\s+commit/);
  });

  test('dispatches reviewers neutrally from primary artifacts', () => {
    expect(reviewerDispatch).toContain('Primary artifacts');
    expect(reviewerDispatch).toContain('Do not include');
    expect(reviewerDispatch).toContain("the orchestrator's conclusion");
    expect(reviewerDispatch).toContain("other reviewers' findings");
    expect(reviewerDispatch).toContain('Claims list');
  });

  test('redacts sensitive data before preserving probe evidence', () => {
    expect(autonomousWorkflow).toContain('secrets, tokens and personal data redacted');
    expect(adversarialReview).toMatch(/redact.*secrets.*tokens.*personal data/i);
  });

  test('does not present untraceable historical counts as evidence', () => {
    expect(autonomousWorkflow).not.toContain('all observed in a single day');
    expect(autonomousWorkflow).not.toContain('all 158');
  });

  test('does not prescribe a shared mutable reflection log', () => {
    expect(autonomousWorkflow).not.toContain('reflections.jsonl');
    expect(productReview).not.toContain('reflections.jsonl');
  });

  test('requires mutation checks to restore the original value', () => {
    expect(autonomousWorkflow).toMatch(/restore the original value/i);
  });

  test('uses exit status and output evidence together', () => {
    expect(resourceSafeExecution).not.toContain('returns exit 0 even on a hard build failure');
    expect(resourceSafeExecution).toMatch(/Treat a non-zero exit status as\s+failure/);
    expect(resourceSafeExecution).toContain('confirm the expected tool summary');
    expect(autonomousWorkflow).not.toContain('never its exit status');
  });

  test('keeps worktrees temporary and task-owned', () => {
    expect(codingDiscipline).toContain('Use the primary checkout for sequential work');
    expect(codingDiscipline).toContain('temporary, task-owned worktree');
    expect(codingDiscipline).toMatch(/do not keep a permanent worktrees directory/i);
    expect(codingDiscipline).not.toContain('code that no longer exists anywhere else');
  });

  test('resolves configurable review effort without weakening target policy', () => {
    expect(autonomousWorkflow).toContain('review-profile');
    expect(autonomousWorkflow).toContain('$CLAUDE_PLUGIN_ROOT/tools/review-profile');
    expect(autonomousWorkflow).toMatch(/target-owned\s+review policy is authoritative/i);
    expect(autonomousWorkflow).toMatch(/freeze.*source head/i);
    expect(autonomousWorkflow).toMatch(/exact-SHA CI evidence/i);
    expect(reviewerDispatch).toMatch(/do not rerun.*exact-SHA CI/i);
  });

  test('uses focused TDD checks during iteration and one authoritative final run', () => {
    expect(testDrivenDevelopment).toMatch(/focused.*RED.*GREEN/is);
    expect(testDrivenDevelopment).toMatch(/full.*exact.*head/is);
    expect(testDrivenDevelopment).not.toContain('Run the FULL test suite (not just the new test)');
  });
});
