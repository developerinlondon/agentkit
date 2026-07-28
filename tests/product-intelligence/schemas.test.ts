import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
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
  'ledger-impossible-time.yaml': 'expected a real ISO-8601 date or date-time',
  'brief-unknown-claim.yaml': "unknown ledger claim 'C-999'",
  'brief-disposition-without-rationale.yaml': 'requires a rationale',
  'brief-missing-subject-name.yaml': "missing required field 'name'",
  'brief-dangling-ledger.yaml': 'not found',
  'brief-multi-origin-unqualified.yaml': 'must name its origin',
  'brief-origin-duplicate-id.yaml': 'duplicate origin id',
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
      // Exactly one: a second error means the fixture breaks two rules and
      // the pinned message could pass for the wrong one.
      expect(errors, errors.join('\n')).toHaveLength(1);
      expect(errors.join('\n')).toContain(message);
    });
  }
});

describe('worked examples', () => {
  const examples = join(skillRoot, 'examples');
  const dirs = () =>
    readdirSync(examples, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  test('ships the three evidence situations, each schema-valid', () => {
    expect(dirs().sort()).toEqual(['mixed', 'repo-only', 'website-only']);
    for (const name of dirs()) {
      expect(validateFile(join(examples, name, 'brief.yaml')), name).toEqual([]);
    }
  });

  test('every claim id cited in the rendered markdown exists in the ledger', () => {
    const ledger = Bun.YAML.parse(readFileSync(join(examples, 'mixed', 'ledger.yaml'), 'utf-8')) as {
      claims: { id: string }[];
    };
    const known = new Set(ledger.claims.map((c) => c.id));
    for (const doc of ['brief.md', 'findings.md']) {
      const text = readFileSync(join(examples, 'mixed', doc), 'utf-8');
      const cited = [...text.matchAll(/\[(C-\d{3,})\]/g)].map((m) => m[1]);
      expect(cited.length, doc).toBeGreaterThan(0);
      for (const id of cited) expect(known.has(id), `${doc} cites ${id}`).toBe(true);
    }
  });
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
