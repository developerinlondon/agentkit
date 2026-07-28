import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const TEST_SLICES = {
  hooks: [
    'tests/agentkit-plugin.test.ts',
    'tests/coding-police-hook.test.ts',
    'tests/coding-police.test.ts',
    'tests/comment-police-hook.test.ts',
    'tests/comment-police.test.ts',
    'tests/git-police-hygiene.test.ts',
    'tests/git-police.test.ts',
    'tests/hook-payload-compat.test.ts',
    'tests/hook-supervisor.test.ts',
    'tests/kubectl-police.test.ts',
    'tests/mr-police.test.ts',
    'tests/pkg-police.test.ts',
    'tests/version-police.test.ts',
  ],
  install: [
    'tests/install-claude-plugin.test.ts',
    'tests/install-hooks.test.ts',
    'tests/install-platform.test.ts',
    'tests/install-prompt.test.ts',
    'tests/install-shared-root.test.ts',
    'tests/install-tools.test.ts',
  ],
  integrations: ['tests/infra-tools-mcp.test.ts', 'tests/test-slices.test.ts'],
  product: [
    'tests/product-intelligence/acquisition.test.ts',
    'tests/product-intelligence/schemas.test.ts',
  ],
  resources: [
    'tests/resource-police.test.ts',
    'tests/resource-run.integration.test.ts',
    'tests/resource-run.test.ts',
    'tests/resource-safety-assets.test.ts',
  ],
  review: [
    'tests/codex-review-hooks.test.ts',
    'tests/product-command.test.ts',
    'tests/review-disciplines.test.ts',
    'tests/review-gate.test.ts',
    'tests/review-police.test.ts',
  ],
  session: ['tests/session/agent-session.test.ts', 'tests/session/install-session-slice.test.ts'],
} as const;

export type TestSlice = keyof typeof TEST_SLICES;

const repoRoot = join(import.meta.dir, '..');
const bunTestFilename = /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx)$/;

export function discoverTestFiles(root = repoRoot): string[] {
  const directories = [root];
  const testFiles: string[] = [];

  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) break;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (entry.name === 'node_modules' || entry.name.startsWith('.'))
      ) {
        continue;
      }

      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      if (entry.isFile() && bunTestFilename.test(entry.name)) {
        testFiles.push(relative(root, path).replaceAll('\\', '/'));
      }
    }
  }

  return testFiles.sort();
}

export function validateTestSlices(testFiles: readonly string[]): string[] {
  const actual = new Set(testFiles);
  const assignmentCounts = new Map<string, number>();
  const errors: string[] = [];

  for (const files of Object.values(TEST_SLICES)) {
    for (const file of files) {
      assignmentCounts.set(file, (assignmentCounts.get(file) ?? 0) + 1);
      if (!actual.has(file)) errors.push(`stale assignment: ${file}`);
    }
  }

  for (const file of testFiles) {
    const count = assignmentCounts.get(file) ?? 0;
    if (count === 0) errors.push(`unassigned test: ${file}`);
    if (count > 1) errors.push(`multiply assigned test: ${file} (${count} slices)`);
  }

  return errors.sort();
}

function failForCoverage(errors: readonly string[]): never {
  for (const error of errors) console.error(error);
  process.exit(1);
}

function runSlice(slice: TestSlice): never {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'test', ...TEST_SLICES[slice]],
    cwd: repoRoot,
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(result.exitCode);
}

if (import.meta.main) {
  const requested = process.argv[2];
  const testFiles = discoverTestFiles();
  const errors = validateTestSlices(testFiles);

  if (errors.length > 0) failForCoverage(errors);
  if (requested === '--check') {
    console.log(`Test slice routing covers ${testFiles.length} test files.`);
    process.exit(0);
  }

  if (!requested || !Object.hasOwn(TEST_SLICES, requested)) {
    console.error(`Unknown test slice: ${requested ?? '(missing)'}`);
    process.exit(2);
  }

  runSlice(requested as TestSlice);
}
