import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(import.meta.dir, '..', 'skills');
const autonomousWorkflow = readFileSync(join(skillsDir, 'autonomous-workflow', 'SKILL.md'), 'utf-8');
const productReview = readFileSync(join(skillsDir, 'product-review', 'SKILL.md'), 'utf-8');

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
});
