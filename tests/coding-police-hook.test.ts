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

function runGit(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function makeGitRepo(root: string): void {
  runGit(['init', '-q'], root);
  runGit(['config', 'user.email', 'test@test.com'], root);
  runGit(['config', 'user.name', 'test'], root);
}

function commitFile(repoDir: string, relPath: string, content: string): void {
  const abs = join(repoDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  runGit(['add', relPath], repoDir);
  runGit(['commit', '-q', '-m', `add ${relPath}`], repoDir);
}

function runHookOnFile(configYaml: string, root: string, filePath: string) {
  const configDir = join(root, 'config', 'agentkit');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), configYaml);

  return spawnSync('bash', [hook], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
    },
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } }),
  });
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

describe('Claude coding-police monolith directory', () => {
  test('blocks a new source file in a directory already at the cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    for (let i = 0; i < 15; i++) {
      commitFile(root, `src/handlers/h${i}.ts`, `export const h${i} = ${i};\n`);
    }
    const target = join(root, 'src/handlers/h15.ts');
    writeFileSync(target, 'export const h15 = 15;\n');

    const result = runHookOnFile('coding-police:\n  max-dir-files: 15\n', root, target);
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('MONOLITH DIRECTORY');
    expect(result.stderr).toContain('15 source files');
    expect(result.stderr).toContain('cap: 15');
  });

  test('allows overwriting an already-tracked file in an over-cap directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    for (let i = 0; i < 16; i++) {
      commitFile(root, `src/handlers/h${i}.ts`, `export const h${i} = ${i};\n`);
    }
    const target = join(root, 'src/handlers/h0.ts');
    writeFileSync(target, 'export const h0 = 100;\n');

    const result = runHookOnFile('coding-police:\n  max-dir-files: 15\n', root, target);
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('MONOLITH DIRECTORY');
  });

  test('max-dir-files: 0 disables the check', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    for (let i = 0; i < 20; i++) {
      commitFile(root, `src/handlers/h${i}.ts`, `export const h${i} = ${i};\n`);
    }
    const target = join(root, 'src/handlers/h20.ts');
    writeFileSync(target, 'export const h20 = 20;\n');

    const result = runHookOnFile('coding-police:\n  max-dir-files: 0\n', root, target);
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('MONOLITH DIRECTORY');
  });

  test('exclude-patterns suppresses the check for homogeneous collections', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    for (let i = 0; i < 15; i++) {
      commitFile(root, `src/routes/r${i}.ts`, `export const r${i} = ${i};\n`);
    }
    const target = join(root, 'src/routes/r15.ts');
    writeFileSync(target, 'export const r15 = 15;\n');

    const result = runHookOnFile(
      'coding-police:\n  max-dir-files: 15\n  exclude-patterns:\n    - routes/\n',
      root,
      target,
    );
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('MONOLITH DIRECTORY');
  });

  test('ignores non-code files even in an over-cap directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    for (let i = 0; i < 15; i++) {
      commitFile(root, `src/handlers/h${i}.ts`, `export const h${i} = ${i};\n`);
    }
    const target = join(root, 'src/handlers/notes.md');
    writeFileSync(target, '# notes\n');

    const result = runHookOnFile('coding-police:\n  max-dir-files: 15\n', root, target);
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('MONOLITH DIRECTORY');
  });
});
