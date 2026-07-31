import { statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import {
  TEST_SLICES,
  type TestSlice,
  discoverTestFiles,
  validateTestSlices,
} from './check-test-slices';

const repoRoot = join(import.meta.dir, '..');

// The real systemd containment suite takes the single machine-wide
// agentkit-run.lock, so anything else invoking bounded-run at the same moment
// fails it on contention rather than on behavior. It is opt-in and skipped by
// default, so this only costs a lane when it is switched on.
const soloFiles = new Set(
  process.env.AGENTKIT_RUN_INTEGRATION === '1'
    ? ['tests/resource-run.integration.test.ts']
    : [],
);

interface Unit {
  slice: TestSlice;
  file: string;
  bytes: number;
  slicePriority: number;
}

interface UnitResult {
  unit: Unit;
  output: string;
  exitCode: number;
  signal: string | null;
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  completed: boolean;
  seconds: number;
}

// --lanes rather than only an environment variable: bounded-run passes an
// allowlist of names through and refuses an `env NAME=value` prefix outright,
// so on a contained host a flag is the only override that survives.
function concurrency(requested: string | undefined): number {
  if (requested === undefined) {
    return Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
  }
  const lanes = Number(requested);
  if (!Number.isInteger(lanes) || lanes < 1) {
    console.error(`Lane count must be a positive integer, got: ${requested}`);
    process.exit(2);
  }
  return lanes;
}

// One child per file rather than one per slice: a single slice holds most of
// the suite's runtime, so scheduling whole slices leaves three lanes idle while
// the fourth decides the wall clock.
function units(slices: readonly TestSlice[]): Unit[] {
  const list = slices.flatMap((slice) =>
    TEST_SLICES[slice].map((file) => ({
      slice,
      file,
      bytes: statSync(join(repoRoot, file)).size,
      slicePriority: TEST_SLICES[slice].length,
    }))
  );
  // Longest-first, with no timing data to sort by: the slice holding the most
  // files is the heaviest, and within it size is the best static cost proxy.
  // A bad guess costs tail latency, never correctness.
  return list.sort(
    (left, right) => right.slicePriority - left.slicePriority || right.bytes - left.bytes,
  );
}

// A colored summary defeats the anchored counters, and FORCE_COLOR reaches the
// children through the inherited environment.
function plain(output: string): string {
  return output.replaceAll(/\u001b\[[0-9;]*m/g, '');
}

function count(summary: string, label: string): number {
  const match = new RegExp(`^\\s*(\\d+) ${label}$`, 'm').exec(summary);
  return match ? Number(match[1]) : 0;
}

async function runUnit(unit: Unit, stream: boolean): Promise<UnitResult> {
  const started = Bun.nanoseconds();
  const child = Bun.spawn({
    cmd: [process.execPath, 'test', unit.file],
    cwd: repoRoot,
    env: process.env,
    stdout: stream ? 'inherit' : 'pipe',
    stderr: stream ? 'inherit' : 'pipe',
  });

  const [stdout, stderr] = stream
    ? ['', '']
    : await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  const exitCode = await child.exited;
  const output = stdout + stderr;
  const summary = plain(output);

  return {
    unit,
    output,
    exitCode,
    signal: child.signalCode,
    pass: count(summary, 'pass'),
    fail: count(summary, 'fail'),
    skip: count(summary, 'skip'),
    todo: count(summary, 'todo'),
    // Bun prints this only once the file is done, so its absence is the one
    // signal separating a finished child from one that was killed mid-run.
    completed: stream || /^Ran \d+ tests? across \d+ files?\./m.test(summary),
    seconds: (Bun.nanoseconds() - started) / 1e9,
  };
}

function broke(result: UnitResult): boolean {
  return (
    result.exitCode !== 0 || result.signal !== null || !result.completed || result.fail > 0
  );
}

function report(result: UnitResult, stream: boolean): void {
  if (!stream) {
    process.stdout.write(`\n===== ${result.unit.slice} :: ${result.unit.file} =====\n`);
    process.stdout.write(result.output);
  }
  if (!broke(result)) return;
  const cause = result.signal ?? `exit ${result.exitCode}`;
  const died = result.completed ? '' : ' — no completion summary, the child died mid-run';
  process.stdout.write(
    `!!!!! FAILED ${result.unit.slice} :: ${result.unit.file} (${cause})${died}\n`,
  );
}

async function main(): Promise<never> {
  const argv = process.argv.slice(2);
  const requested: string[] = [];
  let serial = false;
  let laneFlag: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--serial') serial = true;
    else if (argument === '--lanes') {
      laneFlag = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--lanes=')) laneFlag = argument.slice('--lanes='.length);
    else if (argument.startsWith('-')) {
      console.error(`Unknown option: ${argument}`);
      process.exit(2);
    } else requested.push(argument);
  }

  const unknown = requested.filter((name) => !Object.hasOwn(TEST_SLICES, name));
  if (unknown.length > 0) {
    console.error(`Unknown test slice: ${unknown.join(', ')}`);
    process.exit(2);
  }

  // Only the slice inventory is executed, so a test file missing from it would
  // silently stop running the moment the suite stopped being one `bun test`.
  const routing = validateTestSlices(discoverTestFiles());
  if (routing.length > 0) {
    for (const error of routing) console.error(error);
    process.exit(1);
  }

  const slices = (requested.length > 0 ? requested : Object.keys(TEST_SLICES)) as TestSlice[];
  const queue = units(slices);
  const total = queue.length;
  const lanes = serial
    ? 1
    : Math.min(concurrency(laneFlag ?? process.env.AGENTKIT_TEST_CONCURRENCY), total);
  const results: UnitResult[] = [];
  let running = 0;

  async function lane(): Promise<void> {
    for (;;) {
      const index = queue.findIndex((unit) => !soloFiles.has(unit.file) || running === 0);
      if (index === -1) {
        if (queue.length === 0) return;
        await Bun.sleep(50);
        continue;
      }
      const unit = queue.splice(index, 1)[0] as Unit;
      running += 1;
      const result = await runUnit(unit, serial);
      running -= 1;
      report(result, serial);
      results.push(result);
    }
  }

  const started = Bun.nanoseconds();
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  const elapsed = (Bun.nanoseconds() - started) / 1e9;

  const totals = results.reduce(
    (sum, result) => ({
      pass: sum.pass + result.pass,
      fail: sum.fail + result.fail,
      skip: sum.skip + result.skip,
      todo: sum.todo + result.todo,
    }),
    { pass: 0, fail: 0, skip: 0, todo: 0 },
  );
  const failed = results.filter(broke);

  process.stdout.write(`\n===== ${lanes} lanes, ${results.length} files =====\n`);
  for (
    const result of [...results].sort((left, right) => right.seconds - left.seconds).slice(0, 10)
  ) {
    process.stdout.write(`  ${result.seconds.toFixed(1).padStart(6)}s  ${result.unit.file}\n`);
  }
  // Serial mode streams each child straight through, so nothing was captured to
  // count. Printing zeroes there would read as "nothing ran"; bun already
  // printed a real summary per file.
  process.stdout.write(
    serial
      ? `per-file summaries above, ${results.length} files in ${elapsed.toFixed(1)}s\n`
      : `${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip, ${totals.todo} todo`
        + ` across ${results.length} files in ${elapsed.toFixed(1)}s\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(`FAILED FILES: ${failed.map((result) => result.unit.file).join(', ')}\n`);
  }
  // A lane that threw would otherwise leave a short result list reading as a
  // pass, which is the same lie as a killed child reading as a pass.
  if (results.length !== total) {
    process.stdout.write(`!!!!! ${total - results.length} of ${total} files never reported\n`);
    process.exit(1);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

if (import.meta.main) await main();
