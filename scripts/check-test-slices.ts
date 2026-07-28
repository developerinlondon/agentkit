import { Glob, YAML } from 'bun';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const TEST_SLICES = {
  diagram: [
    'tests/diagram/d2-svg.test.ts',
    'tests/diagram/icons.test.ts',
    'tests/diagram/render.test.ts',
  ],
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
    'tests/install/manifest-readers.test.ts',
    'tests/install/plugin-scripts.test.ts',
    'tests/install/skill-groups.test.ts',
  ],
  integrations: ['tests/infra-tools-mcp.test.ts', 'tests/test-slices.test.ts'],
  product: [
    'tests/product-intelligence/acquisition.test.ts',
    'tests/product-intelligence/composition.test.ts',
    'tests/product-intelligence/deck.test.ts',
    'tests/product-intelligence/portable.test.ts',
    'tests/product-intelligence/render.test.ts',
    'tests/product-intelligence/schemas.test.ts',
    'tests/publish-page/deck-template.test.ts',
    'tests/publish-page/lint.test.ts',
    'tests/publish-page/mermaid-runtime.test.ts',
    'tests/publish-page/pages-police.test.ts',
  ],
  resources: [
    'tests/resource-police.test.ts',
    'tests/resource-run.integration.test.ts',
    'tests/resource-run.test.ts',
    'tests/resource-safety-assets.test.ts',
  ],
  review: [
    'tests/build/mutate.test.ts',
    'tests/build/preflight.test.ts',
    'tests/codex-review-hooks.test.ts',
    'tests/product-command.test.ts',
    'tests/review-disciplines.test.ts',
    'tests/review-gate.test.ts',
    'tests/review-police.test.ts',
    'tests/review-profile.test.ts',
  ],
  session: ['tests/session/agent-session.test.ts', 'tests/session/install-session-slice.test.ts'],
} as const;

export type TestSlice = keyof typeof TEST_SLICES;

const repoRoot = join(import.meta.dir, '..');
const bunTestFilename = /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx)$/;
const productionRoots = [
  '.claude-plugin',
  'hooks',
  'instructions',
  'lib',
  'pages/worker',
  'plugins',
  'plugins-cc',
  'policies',
  'rules',
  'skills',
  'tools',
] as const;
const productionFiles = new Set([
  '.agentkit/config.yaml',
  '.agentkit/product.yaml',
  '.agentkit/review-policy.json',
  'config.example.yaml',
  'install.sh',
]);
// Repository control files are neither installed nor executed at runtime.
const nonRuntimeBasenames = new Set(['.gitignore']);

interface DiscoveredFile {
  absolute: string;
  relative: string;
}

function discoverFiles(root: string): DiscoveredFile[] {
  const directories = [root];
  const files: DiscoveredFile[] = [];

  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) break;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (entry.name === '.git' || entry.name === 'node_modules')
      ) {
        continue;
      }

      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      if (entry.isFile()) {
        files.push({
          absolute: path,
          relative: relative(root, path).replaceAll('\\', '/'),
        });
      }
    }
  }

  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function hasHiddenDirectory(file: string): boolean {
  return file
    .split('/')
    .slice(0, -1)
    .some((part) => part.startsWith('.'));
}

export function discoverTestFiles(root = repoRoot): string[] {
  return discoverFiles(root)
    .filter(
      (file) =>
        !hasHiddenDirectory(file.relative) &&
        bunTestFilename.test(basename(file.relative)),
    )
    .map((file) => file.relative);
}

export function discoverProductionSurfaces(root = repoRoot): string[] {
  const files = discoverFiles(root);

  return files
    .filter((file) => {
      // Test artifacts are governed by the separate exact-once slice inventory.
      if (
        file.relative.startsWith('tests/') ||
        bunTestFilename.test(basename(file.relative))
      ) {
        return false;
      }
      if (nonRuntimeBasenames.has(basename(file.relative))) return false;

      const runtimeRoot = productionRoots.some(
        (root) => file.relative === root || file.relative.startsWith(`${root}/`),
      );
      if (productionFiles.has(file.relative) || runtimeRoot) return true;
      if (hasHiddenDirectory(file.relative)) return false;
      return (
        (statSync(file.absolute).mode & 0o111) !== 0 ||
        readFileSync(file.absolute, 'utf-8').startsWith('#!')
      );
    })
    .map((file) => file.relative);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a list of strings`);
  }
  return value;
}

export function testTaskInputPatterns(contents: string): string[] {
  const config = YAML.parse(contents);
  if (!isRecord(config) || !isRecord(config.fileGroups) || !isRecord(config.tasks)) {
    throw new Error('moon.yml must define fileGroups and tasks');
  }

  const patterns = new Set<string>();
  for (const [taskName, task] of Object.entries(config.tasks)) {
    if (!taskName.startsWith('test-') || !isRecord(task)) continue;

    for (const input of strings(task.inputs, `${taskName}.inputs`)) {
      if (!input.startsWith('group://')) {
        patterns.add(input);
        continue;
      }

      const groupName = input.slice('group://'.length);
      for (const pattern of strings(config.fileGroups[groupName], `fileGroups.${groupName}`)) {
        patterns.add(pattern);
      }
    }
  }

  return [...patterns].sort();
}

export function validateProductionRouting(
  productionSurfaces: readonly string[],
  inputPatterns: readonly string[],
): string[] {
  const globs = inputPatterns.map((pattern) => new Glob(pattern));
  return productionSurfaces
    .filter((file) => !globs.some((glob) => glob.match(file)))
    .map((file) => `unrouted production surface: ${file}`)
    .sort();
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
  const productionSurfaces = discoverProductionSurfaces();
  const moon = readFileSync(join(repoRoot, 'moon.yml'), 'utf-8');
  const errors = [
    ...validateTestSlices(testFiles),
    ...validateProductionRouting(productionSurfaces, testTaskInputPatterns(moon)),
  ].sort();

  if (errors.length > 0) failForCoverage(errors);
  if (requested === '--check') {
    const summary = [
      `Test slice routing covers ${testFiles.length} test files`,
      `${productionSurfaces.length} production surfaces.`,
    ].join(' and ');
    console.log(summary);
    process.exit(0);
  }

  if (!requested || !Object.hasOwn(TEST_SLICES, requested)) {
    console.error(`Unknown test slice: ${requested ?? '(missing)'}`);
    process.exit(2);
  }

  runSlice(requested as TestSlice);
}
