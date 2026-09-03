import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { passing } from './commands';
import { TESTS_DIR } from './constants';
import { installFixture, record } from './fixture';
import { runHook, test } from './probe';

installFixture();

describe('review-police: evasion probe table', () => {
  // Cases live in tests/probe-cases.txt (tab-separated EXPECT<TAB>command) so
  // the table can be extended without editing code, and so neither this file
  // nor the harness contains a merge-shaped shell command of its own — the
  // gate is installed in this very session and denies those in tool calls.
  const lines = readFileSync(join(TESTS_DIR, 'probe-cases.txt'), 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.startsWith('#'));

  test('the probe table is not silently empty', () => {
    expect(lines.length).toBeGreaterThan(10);
  });

  for (const line of lines) {
    const [want, cmd] = line.split('\t');
    test(`${want}: ${cmd}`, () => {
      record(passing);
      const out = runHook(cmd);
      if (want === 'DENY') expect(out).toContain('"deny"');
      else expect(out).toBe('');
    });
  }
});
