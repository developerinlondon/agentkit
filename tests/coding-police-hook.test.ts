import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const hook = join(repoRoot, 'hooks', 'claude', 'coding-police.sh');
const pluginHook = join(repoRoot, 'plugins-cc', 'agentkit', 'hooks', 'coding-police.sh');

const source = `export function alpha() {
  const sharedAlpha = 1;
  const sharedBeta = 2;
}
export function beta() {
  const sharedAlpha = 1;
  const sharedBeta = 2;
}
`;

const settings = `  max-file-lines: 5
  max-function-lines: 2
  min-duplicate-lines: 2
  max-exports-per-file: 1
`;

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function runHook(config: string, shimBin?: (directory: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-coding-hook-'));
  const configDir = join(root, 'config', 'agentkit');
  const codeFile = join(root, 'fixture.ts');
  const binDir = join(root, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir);
  writeFileSync(join(configDir, 'config.yaml'), config);
  writeFileSync(codeFile, source);
  shimBin?.(binDir);

  const result = spawnSync('bash', [hook], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: root,
      PATH: `${binDir}:${process.env.PATH}`,
      XDG_CONFIG_HOME: join(root, 'config'),
    },
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: codeFile } }),
  });
  rmSync(root, { force: true, recursive: true });
  return result;
}

function expectConfiguredThresholds(stderr: string): void {
  expect(stderr).toContain('FILE TOO LONG: 8 lines (limit: 5');
  expect(stderr).toContain('LONG FUNCTION: `alpha` is 4 lines (limit: 2');
  expect(stderr).toContain('DUPLICATE CODE: 2+ line block');
  expect(stderr).toContain('TOO MANY EXPORTS: 2 exports in this file (limit: 1');
}

describe('Claude coding-police configuration', () => {
  test('loads every threshold before a following YAML section', () => {
    const result = runHook(`coding-police:\n${settings}git-police:\n  enabled: true\n`);

    expect(result.status, result.stderr).toBe(0);
    expectConfiguredThresholds(result.stderr);
  });

  test('loads every threshold when coding-police is the final YAML section', () => {
    const result = runHook(`git-police:\n  enabled: true\ncoding-police:\n${settings}`);

    expect(result.status, result.stderr).toBe(0);
    expectConfiguredThresholds(result.stderr);
  });

  test('stops before an unrelated top-level YAML scalar block', () => {
    const result = runHook(
      `coding-police:\n${settings}notes: |\n  max-file-lines: 1\n`,
    );

    expect(result.status, result.stderr).toBe(0);
    expectConfiguredThresholds(result.stderr);
    expect(result.stderr).not.toContain('FILE TOO LONG: 8 lines (limit: 1');
  });

  test('does not depend on GNU grep or negative head line counts', () => {
    const result = runHook(`coding-police:\n${settings}`, (binDir) => {
      writeExecutable(
        join(binDir, 'grep'),
        `#!/usr/bin/env bash
for argument in "$@"; do
  if [[ "$argument" == -*P* ]]; then
    echo "grep: unsupported -P" >&2
    exit 2
  fi
  if [[ "$argument" == *'\\s'* ]]; then
    echo "grep: unsupported \\s" >&2
    exit 2
  fi
done
exec /usr/bin/grep "$@"
`,
      );
      writeExecutable(
        join(binDir, 'head'),
        `#!/usr/bin/env bash
if [[ "$*" == *"-n -1"* ]]; then
  echo "head: illegal line count -- -1" >&2
  exit 2
fi
exec /usr/bin/head "$@"
`,
      );
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('unsupported -P');
    expect(result.stderr).not.toContain('unsupported \\s');
    expect(result.stderr).not.toContain('illegal line count');
    expectConfiguredThresholds(result.stderr);
  });

  test('keeps the Claude plugin hook identical to its source', () => {
    expect(readFileSync(pluginHook, 'utf-8')).toBe(readFileSync(hook, 'utf-8'));
  });
});
