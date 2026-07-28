import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  TEST_SLICES,
  discoverProductionSurfaces,
  discoverTestFiles,
  testTaskInputPatterns,
  validateProductionRouting,
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

  test('discovers nested packages and executable entrypoints as production surfaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-production-discovery-'));

    try {
      for (const file of [
        'package.json',
        'pages/worker/package.json',
        'pages/worker/src/worker.js',
        'pages/worker/wrangler.toml',
        'pages/worker/.gitignore',
        'scripts/entrypoint',
        'tests/probe.sh',
      ]) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '');
      }
      chmodSync(join(root, 'scripts/entrypoint'), 0o755);
      chmodSync(join(root, 'tests/probe.sh'), 0o755);

      expect(discoverProductionSurfaces(root)).toEqual([
        'pages/worker/package.json',
        'pages/worker/src/worker.js',
        'pages/worker/wrangler.toml',
        'scripts/entrypoint',
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('rejects a production surface that matches no test task input', () => {
    const moon = `
fileGroups:
  productInputs:
    - 'covered/**/*'
tasks:
  test-product:
    inputs:
      - 'group://productInputs'
  deploy:
    inputs:
      - 'uncovered/**/*'
`;

    expect(
      validateProductionRouting(
        ['covered/src/worker.js', 'uncovered/src/worker.js'],
        testTaskInputPatterns(moon),
      ),
    ).toEqual(['unrouted production surface: uncovered/src/worker.js']);
  });

  test('routes every production surface to at least one test task input', () => {
    const moon = readFileSync(join(repoRoot, 'moon.yml'), 'utf-8');
    const surfaces = discoverProductionSurfaces();
    const pagesWorker = [
      'pages/worker/package.json',
      'pages/worker/src/worker.js',
      'pages/worker/wrangler.toml',
    ];

    expect(surfaces).toEqual(expect.arrayContaining(pagesWorker));
    expect(validateProductionRouting(surfaces, testTaskInputPatterns(moon))).toEqual(
      [],
    );
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
