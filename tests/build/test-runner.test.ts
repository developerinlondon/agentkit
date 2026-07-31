import { describe, expect, test } from 'bun:test';
import { schedule, soloFiles } from '../../scripts/run-test-slices';

interface Interval {
  unit: string;
  start: number;
  end: number;
}

// Long enough that scheduling jitter cannot manufacture or hide an overlap:
// two units that genuinely run together share tens of milliseconds, and two
// that do not are separated by a whole unit's duration.
const unitMs = 25;

function overlap(left: Interval, right: Interval): boolean {
  return left.start < right.end && right.start < left.end;
}

function overlappingPairs(intervals: readonly Interval[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const [left, right] = [intervals[i] as Interval, intervals[j] as Interval];
      if (overlap(left, right)) pairs.push([left.unit, right.unit].sort().join('+'));
    }
  }
  return pairs.sort();
}

async function run(units: readonly string[], lanes: number, solo: readonly string[]) {
  const soloSet = new Set(solo);
  const intervals: Interval[] = [];
  await schedule(units, lanes, (unit) => soloSet.has(unit), async (unit) => {
    const start = Bun.nanoseconds();
    await Bun.sleep(unitMs);
    intervals.push({ unit, start, end: Bun.nanoseconds() });
  });
  return intervals;
}

describe('the test runner schedules solo units exclusively', () => {
  // The control. Without it the exclusion assertions below could pass on a
  // scheduler that never runs anything concurrently at all, and prove nothing.
  test('ordinary units do overlap, so this harness can see an overlap at all', async () => {
    const intervals = await run(['a', 'b', 'c', 'd'], 4, []);

    expect(intervals).toHaveLength(4);
    expect(overlappingPairs(intervals).length).toBeGreaterThan(0);
  });

  test('nothing runs while a solo unit runs, whatever order it is queued in', async () => {
    for (const units of [['solo', 'a', 'b', 'c'], ['a', 'b', 'c', 'solo'], ['a', 'solo', 'b', 'c']]) {
      const intervals = await run(units, 4, ['solo']);
      const target = intervals.find((interval) => interval.unit === 'solo') as Interval;

      expect(intervals.map((interval) => interval.unit).sort()).toEqual(['a', 'b', 'c', 'solo']);
      const trespassers = intervals
        .filter((interval) => interval.unit !== 'solo' && overlap(interval, target))
        .map((interval) => interval.unit);
      expect(trespassers, `queued as ${units.join(',')}`).toEqual([]);
    }
  });

  // The direction the first implementation got wrong: it gated the solo unit on
  // an idle pool but let ordinary units start freely once it was already going.
  test('an ordinary unit does not join a solo unit that has already started', async () => {
    const intervals = await run(['solo', 'a', 'b', 'c', 'd', 'e'], 4, ['solo']);
    const target = intervals.find((interval) => interval.unit === 'solo') as Interval;

    expect(intervals).toHaveLength(6);
    expect(intervals.filter((interval) => interval.unit !== 'solo' && overlap(interval, target)))
      .toEqual([]);
  });

  test('two solo units never overlap each other', async () => {
    const intervals = await run(['solo-1', 'a', 'solo-2', 'b'], 4, ['solo-1', 'solo-2']);
    const solos = intervals.filter((interval) => interval.unit.startsWith('solo-'));

    expect(intervals).toHaveLength(4);
    expect(solos).toHaveLength(2);
    expect(overlap(solos[0] as Interval, solos[1] as Interval)).toBe(false);
    expect(overlappingPairs(intervals).filter((pair) => pair.includes('solo'))).toEqual([]);
  });

  test('every unit runs exactly once, and a single lane still drains the queue', async () => {
    const units = ['a', 'b', 'solo', 'c'];
    const intervals = await run(units, 1, ['solo']);

    expect(intervals.map((interval) => interval.unit).sort()).toEqual([...units].sort());
    expect(overlappingPairs(intervals)).toEqual([]);
  });

  test('a queue that is entirely solo units still completes', async () => {
    const intervals = await run(['solo-1', 'solo-2', 'solo-3'], 4, [
      'solo-1',
      'solo-2',
      'solo-3',
    ]);

    expect(intervals).toHaveLength(3);
    expect(overlappingPairs(intervals)).toEqual([]);
  });

  // Named rather than derived: each asserts how long spawned work takes, and
  // contention fails such an assertion on load rather than behaviour. Dropping
  // one is a silent return to an intermittently red run.
  test('the suites that assert elapsed time are registered as unshareable', () => {
    for (
      const file of [
        'tests/coding-police-hook.test.ts',
        'tests/hook-supervisor.test.ts',
        'tests/publish-page/mermaid-runtime.test.ts',
      ]
    ) {
      expect([...soloFiles], file).toContain(file);
    }
  });

  test('a unit that throws surfaces as a rejection instead of hanging the pool', async () => {
    const failing = schedule(['solo', 'a'], 2, (unit) => unit === 'solo', async (unit) => {
      if (unit === 'solo') throw new Error('boom');
      await Bun.sleep(unitMs);
    });

    await expect(failing).rejects.toThrow('boom');
  });
});
