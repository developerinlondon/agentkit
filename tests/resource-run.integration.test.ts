import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const enabled = process.env.AGENTKIT_RUN_INTEGRATION === '1';
const repoRoot = dirname(import.meta.dir);
const runner = join(repoRoot, 'tools', 'agentkit-run');
let root: string;

function run(args: string[]) {
  return spawnSync('bash', [runner, ...args], {
    encoding: 'utf-8',
    timeout: 90_000,
    env: process.env,
  });
}

function processExists(pid: number): boolean {
  return spawnSync('kill', ['-0', String(pid)]).status === 0;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-run-integration-'));
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(!enabled)('agentkit-run real systemd containment', () => {
  test('timeout removes a TERM-resistant grandchild from the service cgroup', () => {
    const pidFile = join(root, 'grandchild.pid');
    const command = join(root, 'term-resistant-tree');
    writeFileSync(
      command,
      `#!/usr/bin/env bash
trap '' TERM
(trap '' TERM; echo "$BASHPID" > "${pidFile}"; while true; do sleep 1; done) &
while true; do sleep 1; done
`,
    );
    chmodSync(command, 0o755);

    const result = run(['--profile', 'canary', '--', command]);

    expect(result.status).not.toBe(0);
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(processExists(grandchild)).toBe(false);
  }, 90_000);

  test('MemoryMax terminates an allocator without affecting the caller', () => {
    const allocator = join(root, 'allocator.js');
    writeFileSync(
      allocator,
      `const chunks = [];
while (true) chunks.push(Buffer.alloc(64 * 1024 * 1024, 1));
`,
    );

    const result = run(['--profile', 'canary', '--', 'bun', allocator]);

    expect(result.status).not.toBe(0);
    expect(process.pid).toBeGreaterThan(1);
  }, 90_000);
});
