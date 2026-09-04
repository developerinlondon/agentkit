import { describe, expect } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MERGE } from './commands';
import { installFixture } from './fixture';
import { runHook, runProbedTest, test } from './probe';

installFixture();

describe('review-police test probe: failure diagnostics', () => {
  // A probe that only reports pass/fail leaves a runner-only flake
  // unreproducible: nothing but "expected '' received '...'". This proves the
  // failure message explains itself instead.
  function writeStubHook(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'review-police-probe-diag-'));
    const path = join(dir, 'stub-hook.sh');
    writeFileSync(path, '#!/usr/bin/env bash\ncat >/dev/null\necho -n \'{"decision":"allow"}\'\n');
    chmodSync(path, 0o755);
    return { dir, path };
  }

  test('a failing assertion on the probe result carries stdin, output, exit code, elapsed time, and CLI versions', () => {
    const { dir, path } = writeStubHook();
    try {
      let caught: Error | undefined;
      try {
        runProbedTest(() => {
          expect(runHook(MERGE, { hookPath: path })).toBe('this-value-never-matches');
        });
      } catch (err) {
        caught = err as Error;
      }
      if (!caught) throw new Error('expected the forced assertion to fail');
      expect(caught.message).toContain('runHook diagnostics');
      expect(caught.message).toContain(MERGE);
      expect(caught.message).toContain('exit: 0');
      expect(caught.message).toMatch(/elapsed: \d+ms/);
      expect(caught.message).toContain('{"decision":"allow"}');
      expect(caught.message).toContain('glab --version as seen by the hook');
      expect(caught.message).toContain('gh --version as seen by the hook');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a passing assertion on the probe result carries no diagnostic block', () => {
    const { dir, path } = writeStubHook();
    try {
      expect(() =>
        runProbedTest(() => {
          expect(runHook(MERGE, { hookPath: path })).toBe('{"decision":"allow"}');
        })
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failure with no runHook call in the test carries no diagnostic block', () => {
    let caught: Error | undefined;
    try {
      runProbedTest(() => {
        expect(true).toBe(false);
      });
    } catch (err) {
      caught = err as Error;
    }
    if (!caught) throw new Error('expected the forced assertion to fail');
    expect(caught.message).not.toContain('runHook diagnostics');
  });
});
