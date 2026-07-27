import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateFile } from '../../skills/product-intelligence/scripts/validate.ts';

const repoRoot = dirname(dirname(import.meta.dir));
const skillRoot = join(repoRoot, 'skills', 'product-intelligence');
const validatorScript = join(skillRoot, 'scripts', 'validate.ts');
const fixtures = join(skillRoot, 'schemas', 'fixtures');

const valid = (name: string) => join(fixtures, 'valid', name);
const invalid = (name: string) => join(fixtures, 'invalid', name);

// Each invalid fixture violates exactly one rule; the expected message names
// that rule so a validator that rejects for the wrong reason still fails here.
const expectedFailures: Record<string, string> = {
  'ledger-missing-sources.yaml': 'requires at least one source',
  'ledger-derived-from-observed.yaml': "only valid for class 'inferred'",
  'ledger-contradicts-asymmetric.yaml': 'not symmetric',
  'ledger-inferred-from-proposed.yaml': 'proposals are not evidence',
  'ledger-unknown-derived-ref.yaml': "unknown claim 'C-099'",
  'ledger-duplicate-id.yaml': 'duplicate claim id',
  'ledger-merged-class-confidence.yaml': 'must be one of',
  'ledger-unknown-field.yaml': "unknown field 'severity'",
  'ledger-source-missing-quote.yaml': "missing required field 'quote'",
  'ledger-impossible-date.yaml': 'expected a real ISO-8601 date',
  'brief-unknown-claim.yaml': "unknown ledger claim 'C-999'",
  'brief-disposition-without-rationale.yaml': 'requires a rationale',
  'brief-missing-subject-name.yaml': "missing required field 'name'",
  'brief-dangling-ledger.yaml': 'not found',
};

describe('product-intelligence schemas', () => {
  test('accepts every valid fixture', () => {
    for (const name of readdirSync(join(fixtures, 'valid'))) {
      expect(validateFile(valid(name)), name).toEqual([]);
    }
  });

  test('every invalid fixture is covered by an expectation', () => {
    expect(readdirSync(join(fixtures, 'invalid')).sort()).toEqual(Object.keys(expectedFailures).sort());
  });

  for (const [name, message] of Object.entries(expectedFailures)) {
    test(`rejects ${name} for the right reason`, () => {
      const errors = validateFile(invalid(name));
      expect(errors.length, errors.join('\n')).toBeGreaterThan(0);
      expect(errors.join('\n')).toContain(message);
    });
  }
});

describe('validate.ts CLI', () => {
  const run = (...args: string[]) => spawnSync('bun', [validatorScript, ...args], { encoding: 'utf-8' });

  test('exits 0 and reports ok for valid documents', () => {
    const result = run(valid('ledger.yaml'), valid('brief.yaml'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ok:');
  });

  test('exits 1 and prints each violation for invalid documents', () => {
    const result = run(invalid('ledger-contradicts-asymmetric.yaml'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not symmetric');
  });

  test('exits 2 with usage when given no files', () => {
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
