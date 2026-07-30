import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const hook = join(repoRoot, 'hooks', 'claude', 'coding-police.sh');
const pluginHook = join(repoRoot, 'plugins-cc', 'agentkit', 'hooks', 'coding-police.sh');
const testDarwin = process.platform === 'darwin' ? test : test.skip;

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

// One commit for a whole tree: rapid-fire per-file commits intermittently lose
// the previous file's blob on slow-fsync CI runners ("invalid object … Error
// building trees"), and none of these tests needs per-file history.
function commitTree(repoDir: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(repoDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  runGit(['add', '-A'], repoDir);
  runGit(['commit', '-q', '-m', 'fixture tree'], repoDir);
}

function handlerTree(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    files[`src/handlers/h${i}.ts`] = `export const h${i} = ${i};\n`;
  }
  return files;
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
  // The configured minimum is what this pins; the wording is the check's own
  // business.
  expect(stderr).toContain('the largest is 2+ lines');
  expect(stderr).toContain('TOO MANY EXPORTS: 2 exports in this file (limit: 1');
}

describe('Claude coding-police configuration', () => {
  test('loads every threshold before a following YAML section', () => {
    const result = runHook(`coding-police:\n${settings}git-police:\n  enabled: true\n`);

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
    expectConfiguredThresholds(result.stderr);
  });

  test('loads every threshold when coding-police is the final YAML section', () => {
    const result = runHook(`git-police:\n  enabled: true\ncoding-police:\n${settings}`);

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
    expectConfiguredThresholds(result.stderr);
  });

  test('stops before an unrelated top-level YAML scalar block', () => {
    const result = runHook(
      `coding-police:\n${settings}notes: |\n  max-file-lines: 1\n`,
    );

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
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

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
    expect(result.stderr).not.toContain('unsupported -P');
    expect(result.stderr).not.toContain('unsupported \\s');
    expect(result.stderr).not.toContain('illegal line count');
    expectConfiguredThresholds(result.stderr);
  });

  test('normalizes BSD-style padded wc output in file-length findings', () => {
    const result = runHook(`coding-police:\n${settings}`, (binDir) => {
      writeExecutable(
        join(binDir, 'wc'),
        `#!/usr/bin/env bash
count=$(/usr/bin/wc -l)
printf '    %s\\n' "$count"
`,
      );
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('FILE TOO LONG: 8 lines (limit: 5');
    expect(result.stderr).not.toContain('FILE TOO LONG:     8 lines');
  });

  test('keeps the Claude plugin hook identical to its source', () => {
    expect(readFileSync(pluginHook, 'utf-8')).toBe(readFileSync(hook, 'utf-8'));
  });
});

describe('Claude coding-police repository path portability', () => {
  test('uses physical paths so legacy violations stay silent but growth still blocks', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-path-alias-'));
    const repoDir = join(root, 'physical-repo');
    const aliasDir = join(root, 'repo-alias');
    mkdirSync(repoDir);
    makeGitRepo(repoDir);
    commitFile(
      repoDir,
      'src/legacy.ts',
      'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\n',
    );
    symlinkSync(repoDir, aliasDir, 'dir');
    const aliasedFile = join(aliasDir, 'src', 'legacy.ts');

    try {
      const unchanged = runHookOnFile(
        'coding-police:\n  max-file-lines: 3\n',
        root,
        aliasedFile,
      );
      expect(unchanged.status, unchanged.stderr).toBe(0);

      writeFileSync(
        join(repoDir, 'src', 'legacy.ts'),
        'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\nconst six = 6;\n',
      );
      const grown = runHookOnFile(
        'coding-police:\n  max-file-lines: 3\n',
        root,
        aliasedFile,
      );
      expect(grown.status).toBe(2);
      expect(grown.stderr).toContain('FILE TOO LONG: 6 lines (limit: 3');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  testDarwin('resolves the tracked basename casing before reading the baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-path-case-'));
    makeGitRepo(root);
    commitFile(
      root,
      'src/Legacy.ts',
      'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\n',
    );
    const caseVariant = join(root, 'src', 'legacy.ts');

    try {
      expect(existsSync(caseVariant)).toBe(true);
      const unchanged = runHookOnFile(
        'coding-police:\n  max-file-lines: 3\n',
        root,
        caseVariant,
      );
      expect(unchanged.status, unchanged.stderr).toBe(0);

      writeFileSync(
        join(root, 'src', 'Legacy.ts'),
        'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\nconst six = 6;\n',
      );
      const grown = runHookOnFile(
        'coding-police:\n  max-file-lines: 3\n',
        root,
        caseVariant,
      );
      expect(grown.status).toBe(2);
      expect(grown.stderr).toContain('FILE TOO LONG: 6 lines (limit: 3');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe('Claude coding-police monolith directory', () => {
  test('blocks a new source file in a directory already at the cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    commitTree(root, handlerTree(15));
    const target = join(root, 'src/handlers/h15.ts');
    writeFileSync(target, 'export const h15 = 15;\n');

    const result = runHookOnFile('coding-police:\n  max-dir-files: 15\n', root, target);
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
    expect(result.stderr).toContain('MONOLITH DIRECTORY');
    expect(result.stderr).toContain('15 source files');
    expect(result.stderr).toContain('cap: 15');
  });

  test('allows overwriting an already-tracked file in an over-cap directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    commitTree(root, handlerTree(16));
    const target = join(root, 'src/handlers/h0.ts');
    writeFileSync(target, 'export const h0 = 100;\n');

    const result = runHookOnFile('coding-police:\n  max-dir-files: 15\n', root, target);
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
    expect(result.stderr).not.toContain('MONOLITH DIRECTORY');
  });

  test('max-dir-files: 0 disables the check', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    commitTree(root, handlerTree(20));
    const target = join(root, 'src/handlers/h20.ts');
    writeFileSync(target, 'export const h20 = 20;\n');

    const result = runHookOnFile('coding-police:\n  max-dir-files: 0\n', root, target);
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
    expect(result.stderr).not.toContain('MONOLITH DIRECTORY');
  });

  test('exclude-patterns suppresses the check for homogeneous collections', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    commitTree(root, Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`src/routes/r${i}.ts`, `export const r${i} = ${i};\n`])));
    const target = join(root, 'src/routes/r15.ts');
    writeFileSync(target, 'export const r15 = 15;\n');

    const result = runHookOnFile(
      'coding-police:\n  max-dir-files: 15\n  exclude-patterns:\n    - routes/\n',
      root,
      target,
    );
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
    expect(result.stderr).not.toContain('MONOLITH DIRECTORY');
  });

  test('ignores non-code files even in an over-cap directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentkit-dircap-'));
    makeGitRepo(root);
    commitTree(root, handlerTree(15));
    const target = join(root, 'src/handlers/notes.md');
    writeFileSync(target, '# notes\n');

    const result = runHookOnFile('coding-police:\n  max-dir-files: 15\n', root, target);
    rmSync(root, { force: true, recursive: true });

    expect(result.status, result.stderr).toBe(result.stderr.includes("VIOLATION") ? 2 : 0);
    expect(result.stderr).not.toContain('MONOLITH DIRECTORY');
  });
});

describe('Claude coding-police duplicate reporting is bounded', () => {
  const run = (file: string) =>
    spawnSync('bash', [hook], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file, new_string: 'x' } }),
      encoding: 'utf-8',
    });

  const block = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';

  const dupRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-dup-'));
    const file = join(dir, 'd.ts');
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    return { dir, file, git };
  };

  test('a pathological file stays far inside the hook timeout', () => {
    // The window slides by one, so a duplicated region used to emit roughly one
    // finding per line: 1489 of them on a 1500-line file, which made the
    // subtraction quadratic and took the hook past its 15s registered budget.
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-dupcost-'));
    const file = join(dir, 'big.ts');
    const block = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\n';
    writeFileSync(file, block.repeat(250));
    const started = Date.now();
    const out = `${run(file).stdout ?? ''}${run(file).stderr ?? ''}`;
    const elapsed = Date.now() - started;
    const findings = out.split('\n').filter((l) => l.includes('DUPLICATE CODE')).length;
    // The count assertion is near-tautological under one-finding-per-file; the
    // bound is what carries weight. hooks.json registers 15s for ONE run.
    expect(findings).toBe(1);
    expect(elapsed).toBeLessThan(10_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the reported region size is the real one, not the window minimum', () => {
    // Without coalescing every sliding-window position is its own match, so
    // the largest region reads as the configured minimum however much code is
    // actually duplicated — and the size is what tells you what to extract.
    const dir = mkdtempSync(join(tmpdir(), 'agentkit-dupsize-'));
    const file = join(dir, 'big.ts');
    const P = Array.from({ length: 48 }, (_, i) => `const p${i} = ${i};`).join('\n') + '\n';
    writeFileSync(file, `${P}const z = 0;\n${P}`);
    const out = `${run(file).stdout ?? ''}${run(file).stderr ?? ''}`;
    const m = out.match(/the largest is (\d+)\+ lines/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(40);
    rmSync(dir, { recursive: true, force: true });
  });

  test('MORE duplicated text reports, even adjacent to an existing region', () => {
    // The first cut coalesced regions but kept only the copy COUNT as
    // severity, so 40 lines that became duplicated next to an existing
    // duplicate were byte-identical in shape and equal in metric — silent.
    const { dir, file, git } = dupRepo();
    const P = block('p', 8);
    const Q = block('q', 40);
    writeFileSync(file, `${P}${Q}const z1 = 9;\n${P}const z2 = 9;\n`);
    git('add', '-A');
    git('commit', '-qm', 'P is duplicated, Q is not');
    expect(run(file).status).toBe(0);
    // Q is now duplicated too.
    writeFileSync(file, `${P}${Q}const z1 = 9;\n${P}${Q}const z2 = 9;\n`);
    const worse = run(file);
    expect(`${worse.stdout ?? ''}${worse.stderr ?? ''}`).toContain('DUPLICATE CODE');
    expect(worse.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('LESS duplicated text is silent even when the edit MERGES runs', () => {
    // A run breaks on a normalised-away line inside the FIRST copy, so removing
    // one merges two runs. Summing run lengths counted min-1 twice at that
    // boundary, so the merge alone lowered the total — a refund that could pay
    // for new duplication. The earlier fixture could not catch it: with no
    // interior gaps it was monotone-down under every candidate metric.
    const { dir, file, git } = dupRepo();
    const R = block('r', 20).trimEnd().split('\n');
    const split = `${R.slice(0, 7).join('\n')}\n\n${R.slice(7, 13).join('\n')}\n\n${R.slice(13).join('\n')}\n`;
    const flat = `${R.join('\n')}\n`;
    writeFileSync(file, `${split}const z1 = 9;\n${flat}const z2 = 9;\n${flat}`);
    git('add', '-A');
    git('commit', '-qm', 'three copies, gaps inside the first');
    expect(run(file).status).toBe(0);
    // Gaps removed AND a copy deleted: strictly less duplicated text.
    writeFileSync(file, `${flat}const z1 = 9;\n${flat}`);
    const better = run(file);
    expect(`${better.stdout ?? ''}${better.stderr ?? ''}`).not.toContain('DUPLICATE CODE');
    expect(better.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a THIRD copy of an existing pair reports', () => {
    // Kills the max class: a metric that keeps only the largest region, rather
    // than how much is duplicated, is unmoved by another copy of the same size.
    const { dir, file, git } = dupRepo();
    const P = block('p', 10);
    writeFileSync(file, `${P}const z1 = 9;\n${P}`);
    git('add', '-A');
    git('commit', '-qm', 'two copies');
    expect(run(file).status).toBe(0);
    writeFileSync(file, `${P}const z1 = 9;\n${P}const z2 = 9;\n${P}`);
    const worse = run(file);
    expect(`${worse.stdout ?? ''}${worse.stderr ?? ''}`).toContain('DUPLICATE CODE');
    expect(worse.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('removing interior gaps does not refund NEW duplication elsewhere', () => {
    // The R2-1 fixture: duplication genuinely rises 20 -> 28 lines while two
    // blank lines come out of the first copy. Summing run lengths read the
    // baseline as 30 and the edit as 28, so the subtraction absorbed it and
    // said nothing.
    const { dir, file, git } = dupRepo();
    const R = block('r', 20).trimEnd().split('\n');
    const M = block('m', 8);
    const split = `${R.slice(0, 7).join('\n')}\n\n${R.slice(7, 13).join('\n')}\n\n${R.slice(13).join('\n')}\n`;
    const flat = `${R.join('\n')}\n`;
    writeFileSync(file, `${split}const z1 = 9;\n${flat}`);
    git('add', '-A');
    git('commit', '-qm', 'R duplicated once, gaps inside the first copy');
    expect(run(file).status).toBe(0);
    writeFileSync(file, `${flat}const z1 = 9;\n${flat}const z2 = 9;\n${M}const z3 = 9;\n${M}`);
    const worse = run(file);
    expect(`${worse.stdout ?? ''}${worse.stderr ?? ''}`).toContain('DUPLICATE CODE');
    expect(worse.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
