import { Glob, YAML } from 'bun';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

export const TEST_SLICES = {
  diagram: [
    'tests/diagram/d2-svg.test.ts',
    'tests/diagram/drawio-render.test.ts',
    'tests/diagram/drawio-svg.test.ts',
    'tests/diagram/excalidraw-svg.test.ts',
    'tests/diagram/extract-cli.test.ts',
    'tests/diagram/extract-model.test.ts',
    'tests/diagram/extract-sources.test.ts',
    'tests/diagram/house-root.test.ts',
    'tests/diagram/hugo/module.test.ts',
    'tests/diagram/icons.test.ts',
    'tests/diagram/layout.test.ts',
    'tests/diagram/lockfile.test.ts',
    'tests/diagram/mono-icons.test.ts',
    'tests/diagram/render.test.ts',
    'tests/diagram/typecheck.test.ts',
    'tests/diagram/vendor-icons.test.ts',
  ],
  docs: [
    'tests/docs/asset-types.test.ts',
    'tests/docs/ci-go-cache.test.ts',
    'tests/docs/docs-tone.test.ts',
    'tests/docs/facts.test.ts',
    'tests/docs/versions.test.ts',
  ],
  site: ['tests/site/links.test.ts'],
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
    'tests/hooks-unbound-vars.test.ts',
    'tests/hooks/branch-wip-cap.test.ts',
    'tests/hooks/editor-police.test.ts',
    'tests/hooks/issue-police.test.ts',
    'tests/hooks/prose-police.test.ts',
    'tests/hooks/wait-for.test.ts',
    'tests/hooks/wait-police.test.ts',
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
    'tests/install/bootstrap.test.ts',
    'tests/install/kit-shims.test.ts',
    'tests/install/manifest-readers.test.ts',
    'tests/install/nested-packages.test.ts',
    'tests/install/plugin-scripts.test.ts',
    'tests/install/release-tag.test.ts',
    'tests/install/skill-kits.test.ts',
    'tests/install/uninstall.test.ts',
    'tests/install/update-notice.test.ts',
    'tests/install/wizard.test.ts',
  ],
  integrations: ['tests/infra-tools-mcp.test.ts', 'tests/test-slices.test.ts'],
  memory: [
    'tests/memory/memory-hooks.test.ts',
    'tests/memory/memory-sources.test.ts',
    'tests/memory/ruminate-extractor.test.ts',
  ],
  product: [
    'tests/product-intelligence/acquisition.test.ts',
    'tests/product-intelligence/composition.test.ts',
    'tests/product-intelligence/deck.test.ts',
    'tests/product-intelligence/portable.test.ts',
    'tests/product-intelligence/render.test.ts',
    'tests/product-intelligence/schemas.test.ts',
    'tests/publish-page/accounts.test.ts',
    'tests/publish-page/browser-launch.test.ts',
    'tests/publish-page/deck-template.test.ts',
    'tests/publish-page/device-login.test.ts',
    'tests/publish-page/figure-tools.test.ts',
    'tests/publish-page/lint.test.ts',
    'tests/publish-page/mermaid-runtime.test.ts',
    'tests/publish-page/migrations.test.ts',
    'tests/publish-page/pages-police.test.ts',
    'tests/publish-page/publish-freshness.test.ts',
    'tests/publish-page/share-links.test.ts',
    'tests/publish-page/theme-chrome.test.ts',
    'tests/publish-page/worker.test.ts',
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
    'tests/build/test-runner.test.ts',
    'tests/codex-review-hooks.test.ts',
    'tests/product-command.test.ts',
    'tests/review-disciplines.test.ts',
    'tests/review-gate.test.ts',
    'tests/review-police/bypasses.test.ts',
    'tests/review-police/fail-closed.test.ts',
    'tests/review-police/forge-binding.test.ts',
    'tests/review-police/police-hooks-parse.test.ts',
    'tests/review-police/probe-diagnostics.test.ts',
    'tests/review-police/probe-table.test.ts',
    'tests/review-police/semantics.test.ts',
    'tests/review-police/target-policy.test.ts',
    'tests/review-police/wrapper-coverage.test.ts',
    'tests/review-profile.test.ts',
  ],
  session: ['tests/session/agent-session.test.ts', 'tests/session/install-session-slice.test.ts'],
  taste: [
    'tests/taste/judgment-lane.test.ts',
    'tests/taste/judgment.test.ts',
    'tests/taste/key-path.test.ts',
    'tests/taste/kinds.test.ts',
    'tests/taste/layout.test.ts',
    'tests/taste/lint.test.ts',
    'tests/taste/police-lanes.test.ts',
    'tests/taste/police.test.ts',
    'tests/taste/scopes.test.ts',
    'tests/taste/skill.test.ts',
    'tests/taste/sources.test.ts',
    'tests/taste/sync.test.ts',
    'tests/taste/tag-sequence.test.ts',
    'tests/taste/target-repo.test.ts',
    'tests/taste/visibility.test.ts',
  ],
  wip: [
    'tests/wip/plan-gate.test.ts',
    'tests/wip/plan-police.test.ts',
    'tests/wip/wip.test.ts',
  ],
} as const;

export type TestSlice = keyof typeof TEST_SLICES;
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;

// Bun reads a bare relative argument as a substring filter, so `tests/a.test.ts` also
// runs `x-tests/a.test.ts`; a `./` prefix or an absolute path names one file exactly.
export function bunTestCommand(files: readonly string[]): string[] {
  return [
    process.execPath,
    'test',
    `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
    ...files.map((file) => (isAbsolute(file) ? file : `./${file}`)),
  ];
}

export function sliceCommand(slice: TestSlice): string[] {
  return bunTestCommand(TEST_SLICES[slice]);
}

export function sliceRun(slice: TestSlice): { cmd: string[]; files: number } {
  return { cmd: sliceCommand(slice), files: TEST_SLICES[slice].length };
}

const repoRoot = join(import.meta.dir, '..');
const bunTestFilename = /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx)$/;
const productionRoots = [
  '.claude-plugin',
  'hooks',
  'instructions',
  'kits',
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

// A colored summary defeats anchored matching, and FORCE_COLOR reaches the children
// through the inherited environment.
export function plainOutput(output: string): string {
  return output.replaceAll(/\u001b\[[0-9;]*m/g, '');
}

// Bun's completion line, read from stderr only: test code writes to stdout and could
// print a summary-shaped line of its own. The last one is bun's, printed when the run ends.
export function bunSummary(stderr: string): { tests: number; files: number } | null {
  const lines = [...plainOutput(stderr).matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)];
  const last = lines.at(-1);
  return last ? { tests: Number(last[1]), files: Number(last[2]) } : null;
}

// A zero exit proves nothing on its own: a test file that calls process.exit(0) while
// loading ends bun early, green, with its tests unrun. Only bun's closing summary,
// naming at least one test, makes a zero exit a pass. Given exact paths, bun's summary
// counts exactly the files it was given; any other count was echoed by test code in a run
// that died early. A test that echoes a summary with the right count to stderr before
// exiting still passes: from bun's output alone it is indistinguishable from bun's own.
export function sliceVerdict(
  exitCode: number,
  signal: string | null,
  stderr: string,
  files: number,
): { code: number; reason?: string } {
  if (signal !== null) return { code: 1, reason: `bun was ended by ${signal}` };
  if (exitCode !== 0) return { code: exitCode };
  const summary = bunSummary(stderr);
  if (summary === null) return { code: 1, reason: 'bun printed no test summary: the run ended before its tests reported' };
  if (summary.files !== files) {
    return { code: 1, reason: `bun's summary covers ${summary.files} files, the slice has ${files}` };
  }
  if (summary.tests === 0) return { code: 1, reason: 'the slice ran no tests' };
  return { code: 0 };
}

const SUMMARY_TAIL = 64 * 1024;

type Sink = { write(chunk: Uint8Array): unknown };

// Runs a bun test command, streaming its output to the sinks (the terminal by default),
// and returns the exit code the slice should report.
export async function runChecked(
  cmd: string[],
  cwd: string,
  label: string,
  files: number,
  sinks: { stdout: Sink; stderr: Sink } = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const proc = Bun.spawn({ cmd, cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' });
  let stderrTail = '';
  const relay = async (stream: ReadableStream<Uint8Array>, sink: Sink, keep: boolean) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      sink.write(chunk);
      if (keep) stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-SUMMARY_TAIL);
    }
  };
  await Promise.all([relay(proc.stdout, sinks.stdout, false), relay(proc.stderr, sinks.stderr, true)]);
  const verdict = sliceVerdict(await proc.exited, proc.signalCode, stderrTail, files);
  if (verdict.reason) {
    sinks.stderr.write(new TextEncoder().encode(`check-test-slices: ${label}: ${verdict.reason}\n`));
  }
  return verdict.code;
}

export function runSlice(slice: TestSlice, run = runChecked): Promise<number> {
  const { cmd, files } = sliceRun(slice);
  return run(cmd, repoRoot, slice, files);
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

  process.exit(await runSlice(requested as TestSlice));
}
