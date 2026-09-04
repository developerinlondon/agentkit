import { describe, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_DIR } from './constants';
import { test } from './probe';

describe('every police hook parses', () => {
  // A hook with a shell syntax error prints nothing and exits non-zero, which
  // the harness reads as ALLOW — so a typo in ANY of these silently disarms
  // the gate it implements. This happened for real: an embedded python block
  // quoted with "'"'" sequences terminated the shell string early, and the
  // whole hook stopped running while the suite still passed.
  const hookDir = HOOK_DIR;
  for (const name of readdirSync(hookDir).filter((f) => f.endsWith('.sh'))) {
    test(`${name} is syntactically valid bash`, () => {
      const res = spawnSync('bash', ['-n', join(hookDir, name)], { encoding: 'utf-8' });
      expect(res.stderr, `${name}: ${res.stderr}`).toBe('');
      expect(res.status).toBe(0);
    });
  }
});
