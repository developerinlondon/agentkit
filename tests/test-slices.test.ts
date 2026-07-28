import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  TEST_SLICES,
  discoverTestFiles,
  validateTestSlices,
} from '../scripts/check-test-slices';

const repoRoot = join(import.meta.dir, '..');

function moonBlock(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

describe('test slice routing', () => {
  test('assigns every test file to exactly one slice', () => {
    expect(validateTestSlices(discoverTestFiles())).toEqual([]);
  });

  test('keeps the committed assignments in deterministic order', () => {
    for (const files of Object.values(TEST_SLICES)) {
      expect(files).toEqual([...files].sort());
    }
  });

  test('discovers every Bun default test filename while excluding ignored directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-test-discovery-'));
    const conventions = ['suite.test', 'suite_test', 'suite.spec', 'suite_spec'];
    const extensions = ['js', 'jsx', 'ts', 'tsx'];
    const expected = [
      ...conventions.flatMap((convention, conventionIndex) =>
        extensions.map(
          (extension, extensionIndex) =>
            `area-${conventionIndex}/case-${extensionIndex}/${convention}.${extension}`,
        ),
      ),
      '.root.test.ts',
    ];

    try {
      for (const file of [
        ...expected,
        '.hidden/ignored.test.ts',
        'src/.fixtures/ignored.spec.js',
        'node_modules/pkg/ignored_test.tsx',
        'src/node_modules/pkg/ignored_spec.jsx',
        'src/ordinary.ts',
      ]) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '');
      }

      expect(discoverTestFiles(root)).toEqual(expected.sort());
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('runs slice coverage validation for every project change', () => {
    const moon = readFileSync(join(repoRoot, 'moon.yml'), 'utf-8');
    const task = moonBlock(moon, '  check-test-slices:', '\n  test-hooks:');
    expect(task).not.toContain('\n    inputs:');
  });

  test('routes the check wrapper and review probe data to their consumers', () => {
    const moon = readFileSync(join(repoRoot, 'moon.yml'), 'utf-8');
    const criticalInputs = moonBlock(moon, '  criticalInputs:', '\n  hookInputs:');
    const reviewInputs = moonBlock(moon, '  reviewInputs:', '\n  sessionInputs:');

    expect(criticalInputs).toMatch(/- ['"]scripts\/product-command['"]/);
    expect(reviewInputs).toMatch(/- ['"]tests\/probe-cases\.txt['"]/);
  });
});
