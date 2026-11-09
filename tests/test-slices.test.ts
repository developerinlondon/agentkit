import { YAML } from 'bun';
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
  DEFAULT_TEST_TIMEOUT_MS,
  TEST_SLICES,
  discoverProductionSurfaces,
  discoverTestFiles,
  runChecked,
  sliceCommand,
  sliceVerdict,
  testsRan,
  testTaskInputPatterns,
  validateProductionRouting,
  validateTestSlices,
} from '../scripts/check-test-slices';

const repoRoot = join(import.meta.dir, '..');

// Restated rather than derived: this group decides which changes escalate CI to
// the full suite, so narrowing it has to fail a diff instead of passing quietly.
const CRITICAL_INPUTS = [
  '.agentkit/config.yaml',
  '.agentkit/product.yaml',
  '.agentkit/review-policy.json',
  '.claude-plugin/marketplace.json',
  '.github/actions/**/*',
  '.github/workflows/**/*',
  '.moon/**/*',
  '.prototools',
  'bun.lock',
  'config.example.yaml',
  'docs/review-process.md',
  'hooks/**/*',
  'install.sh',
  'instructions/coding-discipline.md',
  'instructions/evidence-gated-review.md',
  'lib/install-platform.sh',
  'lib/skill-kits.sh',
  'moon.yml',
  'package.json',
  'plugins-cc/agentkit-product/skills/product-review/**/*',
  'plugins-cc/agentkit/.claude-plugin/plugin.json',
  'plugins-cc/agentkit/hooks/**/*',
  'plugins-cc/agentkit-adversarial-review/**/*',
  'plugins-cc/agentkit/skills/autonomous-workflow/**/*',
  'plugins-cc/agentkit/skills/product-review/**/*',
  'plugins-cc/agentkit/skills/test-driven-development/**/*',
  'plugins/*.ts',
  'policies/**/*',
  'scripts/check-test-slices.ts',
  'scripts/product-command',
  'scripts/run-test-slices.ts',
  'scripts/skill-kits.ts',
  'scripts/sync-cc-plugin.sh',
  'skills/KITS',
  'skills/adversarial-review/**/*',
  'skills/autonomous-workflow/**/*',
  'skills/product-review/**/*',
  'skills/test-driven-development/**/*',
  'tests/agentkit-plugin.test.ts',
  'tests/codex-review-hooks.test.ts',
  'tests/hook-supervisor.test.ts',
  'tests/install-claude-plugin.test.ts',
  'tests/install-tools.test.ts',
  'tests/review-disciplines.test.ts',
  'tests/review-gate.test.ts',
  'tests/review-police/**/*',
  'tests/review-profile.test.ts',
  'tests/test-slices.test.ts',
  'tools/review-gate',
  'tools/review-profile',
];

type MoonConfig = {
  fileGroups: Record<string, string[]>;
  tasks: Record<string, { inputs?: string[] }>;
};

function readMoonConfig(): MoonConfig {
  return YAML.parse(readFileSync(join(repoRoot, 'moon.yml'), 'utf-8')) as MoonConfig;
}

// A slice counts as passed only when its tests ran; an exit code alone can be green with
// every test unrun.
describe('a slice run passes only when bun reports its tests', () => {
  const summary = 'bun test v1\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [10.00ms]\n';

  test('a zero exit with a summary naming tests passes', () => {
    expect(sliceVerdict(0, null, summary).code).toBe(0);
  });

  test('a failing run keeps its own exit code', () => {
    expect(sliceVerdict(1, null, summary).code).toBe(1);
  });

  test('a run ended by a signal fails even with a summary', () => {
    expect(sliceVerdict(0, 'SIGTERM', summary)).toMatchObject({ code: 1, reason: expect.stringMatching(/SIGTERM/) });
  });

  test('a zero exit with no summary, or a summary of no tests, fails', () => {
    expect(sliceVerdict(0, null, 'some output\n')).toMatchObject({ code: 1, reason: expect.stringMatching(/no test summary/) });
    expect(sliceVerdict(0, null, 'Ran 0 tests across 1 file.\n')).toMatchObject({ code: 1, reason: expect.stringMatching(/ran no tests/) });
  });

  test('the summary is the last line that starts with it, colour stripped', () => {
    expect(testsRan('noise Ran 9 tests across 1 file.\n')).toBeNull();
    expect(testsRan('Ran 9 tests across 1 file.\nRan 2 tests across 1 file.\n')).toBe(2);
    expect(testsRan('\u001b[1mRan 1 test across 1 file.\u001b[0m\n')).toBe(1);
  });

  describe('the runner applies the verdict to real bun runs', () => {
    const fixture = (body: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'agentkit-slice-run-'));
      writeFileSync(join(dir, 'case.test.ts'), `import { test, expect } from 'bun:test';\n${body}`);
      return dir;
    };
    const run = async (body: string) => {
      const dir = fixture(body);
      const env = { HOME: process.env.HOME, BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR };
      process.env.HOME = dir;
      process.env.BUN_INSTALL_CACHE_DIR = join(dir, '.bun-cache');
      try {
        // Silent sinks: a fixture's own summary must not reach this file's output, where
        // the full-suite runner reads the counts.
        const silent = { write: () => true };
        return await runChecked([process.execPath, 'test', join(dir, 'case.test.ts')], dir, 'fixture', {
          stdout: silent,
          stderr: silent,
        });
      } finally {
        process.env.HOME = env.HOME;
        process.env.BUN_INSTALL_CACHE_DIR = env.BUN_INSTALL_CACHE_DIR;
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test('a run whose tests pass exits 0', async () => {
      expect(await run("test('passes', () => expect(1).toBe(1));\n")).toBe(0);
    });

    test('a file that exits 0 while loading fails the slice, though bun itself exits 0', async () => {
      expect(await run("process.exit(0);\ntest('never runs', () => expect(1).toBe(2));\n")).toBe(1);
    });

    test('a summary printed by test code before an early exit does not pass the slice', async () => {
      expect(await run("console.log('Ran 7 tests across 1 file.');\nprocess.exit(0);\n")).toBe(1);
    });
  });
});

describe('test slice routing', () => {
  test('direct slice runs use the same bounded default as the authoritative runner', () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(60_000);
    expect(sliceCommand('review')).toEqual([
      process.execPath,
      'test',
      '--timeout=60000',
      ...TEST_SLICES.review,
    ]);
  });

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

  test('discovers installed runtime roots and executable entrypoints', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-production-discovery-'));
    const runtimeFiles = [
      '.agentkit/config.yaml',
      '.agentkit/review-policy.json',
      '.claude-plugin/marketplace.json',
      'config.example.yaml',
      'hooks/codex/hooks.json',
      'install.sh',
      'instructions/coding-discipline.md',
      'lib/install-platform.sh',
      'pages/worker/package.json',
      'pages/worker/src/worker.js',
      'pages/worker/wrangler.toml',
      'plugins/resource-police.ts',
      'plugins-cc/agentkit/.mcp.json',
      'policies/codex/resource-police.rules',
      'rules/coding-standards.md',
      'skills/product-review/SKILL.md',
      'tools/agent-session',
    ];

    try {
      for (const file of [
        ...runtimeFiles,
        'package.json',
        'pages/worker/.gitignore',
        'scripts/entrypoint',
        'tests/probe.sh',
      ]) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '');
      }
      for (const file of [
        'hooks/codex/hooks.json',
        'plugins/resource-police.ts',
        'tools/agent-session',
      ]) {
        chmodSync(join(root, file), 0o644);
      }
      chmodSync(join(root, 'scripts/entrypoint'), 0o755);
      chmodSync(join(root, 'tests/probe.sh'), 0o755);

      expect(discoverProductionSurfaces(root)).toEqual(
        [...runtimeFiles, 'scripts/entrypoint'].sort(),
      );
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
    // A moon task without declared inputs is never filtered out as unaffected.
    expect(readMoonConfig().tasks['check-test-slices'].inputs).toBeUndefined();
  });

  test('gates the full suite on exactly the committed critical surfaces', () => {
    const config = readMoonConfig();
    expect(config.tasks['test-full'].inputs).toContain('group://criticalInputs');
    expect([...config.fileGroups.criticalInputs].sort()).toEqual(
      [...CRITICAL_INPUTS].sort(),
    );
  });

  test('routes the check wrapper and review probe data to their consumers', () => {
    const { fileGroups } = readMoonConfig();

    expect(fileGroups.criticalInputs).toContain('scripts/product-command');
    expect(fileGroups.reviewInputs).toContain('tests/probe-cases.txt');
  });

  test('never runs affected slices alongside the critical full suite', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf-8');

    expect(workflow).toContain('moon query affected');
    expect(workflow).toMatch(
      /if: steps\.test-mode\.outputs\.mode == 'full'[\s\S]*run: moon ci agentkit:test-full/,
    );
    expect(workflow).toMatch(
      /if: steps\.test-mode\.outputs\.mode == 'affected'[\s\S]*run: moon ci/,
    );
  });
});
