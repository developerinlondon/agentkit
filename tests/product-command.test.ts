import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const commandScript = join(repoRoot, 'scripts', 'product-command');
let root = '';

function executable(name: string, body: string) {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function invoke(platform: string, profile: string, command: string[]) {
  const shell = [
    `source '${commandScript}'`,
    `run_product_command '${platform}' '${profile}' -- "$@"`,
  ].join('; ');
  return spawnSync('bash', ['-c', shell, 'product-command-test', ...command], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${root}:/usr/bin:/bin` },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-product-command-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('portable product command', () => {
  test('delegates Linux workloads to the installed bounded runner with exact argv', () => {
    executable('agentkit-run', "printf 'runner:%s\\n' \"$*\"");
    const result = invoke('linux', 'default', ['bun', 'test']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('runner:--profile default -- bun test');
  });

  test('fails closed when Linux containment is unavailable', () => {
    const result = invoke('linux', 'default', ['bun', 'test']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('agentkit-run is required on Linux');
  });

  test('runs the same exact command directly on non-Linux hosts', () => {
    const workload = executable('workload', "printf 'direct:%s\\n' \"$*\"");
    const result = invoke('darwin', 'default', [workload, 'one', 'two']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('direct:one two');
  });

  test('keeps every product-review command verbatim and cross-platform', () => {
    const product = readFileSync(join(repoRoot, '.agentkit', 'product.yaml'), 'utf-8');
    expect(product).toContain('build: scripts/product-command default -- bun install');
    expect(product).toContain('verify: scripts/product-command default -- bun test');
    expect(product).toContain('run: scripts/product-command default -- echo ok');
    expect(product).toContain(
      'run: scripts/product-command default -- bun plugins-cc/agentkit/server/index.ts',
    );
  });
});
