import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(import.meta.dir, '..', 'skills');
const instructionsDir = join(import.meta.dir, '..', 'instructions');
const autonomousWorkflow = readFileSync(join(skillsDir, 'autonomous-workflow', 'SKILL.md'), 'utf-8');
const productReview = readFileSync(join(skillsDir, 'product-review', 'SKILL.md'), 'utf-8');
const resourceSafeExecution = readFileSync(
  join(skillsDir, 'resource-safe-execution', 'SKILL.md'),
  'utf-8',
);
const codingDiscipline = readFileSync(join(instructionsDir, 'coding-discipline.md'), 'utf-8');

describe('review disciplines', () => {
  test('keeps evidence checks in the review workflow', () => {
    expect(autonomousWorkflow).toContain('Audit the claims, not just the logic');
    expect(autonomousWorkflow).toContain('Observe External Behaviour Before Building On It');
    expect(productReview).toContain('Observed vs inferred');
  });

  test('redacts sensitive data before preserving probe evidence', () => {
    expect(autonomousWorkflow).toContain('secrets, tokens and personal data redacted');
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
});
