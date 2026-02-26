import { describe, test, expect } from 'bun:test';
import codingPolice, {
  checkFileLength,
  checkFunctionLengths,
  checkDuplicateBlocks,
  checkExportCount,
} from '../plugins/coding-police';

// ---------------------------------------------------------------------------
// Mock context (matches pattern from other police tests)
// ---------------------------------------------------------------------------

const mockCtx = {
  client: {},
  project: {},
  directory: '/tmp',
  worktree: '/tmp',
  serverUrl: new URL('http://localhost'),
  $: {},
} as any;

// ---------------------------------------------------------------------------
// Helper: generate lines
// ---------------------------------------------------------------------------

function generateLines(count: number, template = 'const x = 1;'): string[] {
  return Array.from({ length: count }, (_, i) => `${template} // line ${i + 1}`);
}

// ---------------------------------------------------------------------------
// Check 1: File length
// ---------------------------------------------------------------------------

describe('checkFileLength', () => {
  test('returns null for files under limit', () => {
    const lines = generateLines(500);
    expect(checkFileLength(lines, 1000)).toBeNull();
  });

  test('returns null for files exactly at limit', () => {
    const lines = generateLines(1000);
    expect(checkFileLength(lines, 1000)).toBeNull();
  });

  test('returns warning for files over limit', () => {
    const lines = generateLines(1050);
    const result = checkFileLength(lines, 1000);
    expect(result).not.toBeNull();
    expect(result).toContain('FILE TOO LONG');
    expect(result).toContain('1050 lines');
    expect(result).toContain('limit: 1000');
    expect(result).toContain('over by 50');
  });

  test('returns warning with correct excess count', () => {
    const lines = generateLines(1500);
    const result = checkFileLength(lines, 1000);
    expect(result).toContain('over by 500');
  });
});

// ---------------------------------------------------------------------------
// Check 2: Function lengths
// ---------------------------------------------------------------------------

describe('checkFunctionLengths', () => {
  test('returns empty for short functions', () => {
    const code = [
      'function shortFunc() {',
      '  const a = 1;',
      '  return a;',
      '}',
    ];
    expect(checkFunctionLengths(code, 100)).toEqual([]);
  });

  test('detects long named functions', () => {
    const body = Array.from({ length: 120 }, (_, i) => `  const x${i} = ${i};`);
    const code = ['function longFunc() {', ...body, '}'];
    const warnings = checkFunctionLengths(code, 100);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('longFunc');
    expect(warnings[0]).toContain('LONG FUNCTION');
  });

  test('detects long async functions', () => {
    const body = Array.from({ length: 110 }, (_, i) => `  await fetch(${i});`);
    const code = ['async function fetchAll() {', ...body, '}'];
    const warnings = checkFunctionLengths(code, 100);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('fetchAll');
  });

  test('detects long exported functions', () => {
    const body = Array.from({ length: 110 }, (_, i) => `  const x${i} = ${i};`);
    const code = ['export function bigExport() {', ...body, '}'];
    const warnings = checkFunctionLengths(code, 100);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('bigExport');
  });

  test('detects long Python functions', () => {
    const body = Array.from({ length: 110 }, (_, i) => `    x${i} = ${i}`);
    const code = ['def long_python_func():', ...body, '', 'def next_func():'];
    const warnings = checkFunctionLengths(code, 100);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('long_python_func');
  });

  test('detects long Go functions', () => {
    const body = Array.from({ length: 110 }, (_, i) => `  x := ${i}`);
    const code = ['func longGoFunc() error {', ...body, '}'];
    const warnings = checkFunctionLengths(code, 100);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('longGoFunc');
  });

  test('detects long Rust functions', () => {
    const body = Array.from({ length: 110 }, (_, i) => `    let x${i} = ${i};`);
    const code = ['pub async fn long_rust_fn() -> Result<()> {', ...body, '}'];
    const warnings = checkFunctionLengths(code, 100);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('long_rust_fn');
  });

  test('ignores short functions among long ones', () => {
    const shortBody = ['  return 1;'];
    const longBody = Array.from({ length: 110 }, (_, i) => `  const x${i} = ${i};`);
    const code = [
      'function short() {',
      ...shortBody,
      '}',
      'function long() {',
      ...longBody,
      '}',
    ];
    const warnings = checkFunctionLengths(code, 100);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('long');
    expect(warnings[0]).not.toContain('short');
  });
});

// ---------------------------------------------------------------------------
// Check 3: Duplicate code blocks
// ---------------------------------------------------------------------------

describe('checkDuplicateBlocks', () => {
  test('returns empty when no duplicates', () => {
    const code = [
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
      'const e = 5;',
      'const f = 6;',
      'const g = 7;',
    ];
    expect(checkDuplicateBlocks(code, 6)).toEqual([]);
  });

  test('detects duplicated blocks', () => {
    const block = [
      'const x = getUser();',
      'const y = validate(x);',
      'const z = transform(y);',
      'await save(z);',
      'logger.info("done");',
      'return z;',
    ];
    const code = [
      'function handler1() {',
      ...block,
      '}',
      '',
      'function handler2() {',
      ...block,
      '}',
    ];
    const warnings = checkDuplicateBlocks(code, 6);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('DUPLICATE CODE');
    expect(warnings[0]).toContain('DRY');
  });

  test('ignores duplicate blank lines and comments', () => {
    const code = [
      '// comment',
      '',
      '// comment',
      '',
      '// comment',
      '',
      '// comment',
      '',
      '// another',
      '',
      '// another',
      '',
    ];
    expect(checkDuplicateBlocks(code, 6)).toEqual([]);
  });

  test('ignores duplicate import lines', () => {
    const code = [
      "import { a } from 'a';",
      "import { b } from 'b';",
      "import { c } from 'c';",
      "import { d } from 'd';",
      "import { e } from 'e';",
      "import { f } from 'f';",
      '',
      "import { a } from 'a';",
      "import { b } from 'b';",
      "import { c } from 'c';",
      "import { d } from 'd';",
      "import { e } from 'e';",
      "import { f } from 'f';",
    ];
    expect(checkDuplicateBlocks(code, 6)).toEqual([]);
  });

  test('respects minLines threshold', () => {
    const block = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
    const code = [...block, '', ...block];
    // Block is 3 lines, threshold is 6 — should not trigger
    expect(checkDuplicateBlocks(code, 6)).toEqual([]);
    // Block is 3 lines, threshold is 3 — should trigger
    const warnings = checkDuplicateBlocks(code, 3);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Check 4: Export count
// ---------------------------------------------------------------------------

describe('checkExportCount', () => {
  test('returns null for few exports', () => {
    const code = [
      'export function a() {}',
      'export function b() {}',
      'export const c = 1;',
    ];
    expect(checkExportCount(code, 15)).toBeNull();
  });

  test('returns warning when exports exceed limit', () => {
    const code = Array.from(
      { length: 20 },
      (_, i) => `export function fn${i}() {}`,
    );
    const result = checkExportCount(code, 15);
    expect(result).not.toBeNull();
    expect(result).toContain('TOO MANY EXPORTS');
    expect(result).toContain('20 exports');
    expect(result).toContain('limit: 15');
  });

  test('counts different export types', () => {
    const code = [
      'export function a() {}',
      'export const b = 1;',
      'export let c = 2;',
      'export var d = 3;',
      'export class E {}',
      'export interface F {}',
      'export type G = string;',
      'export enum H {}',
      'export async function i() {}',
      'export default function j() {}',
    ];
    // 10 exports, limit 5 — should warn
    const result = checkExportCount(code, 5);
    expect(result).not.toBeNull();
    expect(result).toContain('10 exports');
  });

  test('does not count non-export lines', () => {
    const code = [
      'function internal() {}',
      'const local = 1;',
      '// export function commented() {}',
      'export function onlyOne() {}',
    ];
    expect(checkExportCount(code, 15)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plugin integration (hook wiring)
// ---------------------------------------------------------------------------

describe('coding-police plugin', () => {
  test('ignores non-edit/write tools', async () => {
    const hooks = await codingPolice(mockCtx);
    const input = { tool: 'bash', sessionID: 'test', callID: 'test' };
    const output = { title: 'foo.ts', output: 'done', metadata: {} };
    await hooks['tool.execute.after']!(input, output);
    expect(output.output).toBe('done');
  });

  test('ignores non-code files', async () => {
    const hooks = await codingPolice(mockCtx);
    const input = { tool: 'write', sessionID: 'test', callID: 'test' };
    const output = { title: 'readme.md', output: 'done', metadata: {} };
    await hooks['tool.execute.after']!(input, output);
    expect(output.output).toBe('done');
  });

  test('ignores generated/lock files', async () => {
    const hooks = await codingPolice(mockCtx);
    const input = { tool: 'write', sessionID: 'test', callID: 'test' };
    const output = { title: 'types.d.ts', output: 'done', metadata: {} };
    await hooks['tool.execute.after']!(input, output);
    expect(output.output).toBe('done');
  });

  test('ignores lock files', async () => {
    const hooks = await codingPolice(mockCtx);
    const input = { tool: 'edit', sessionID: 'test', callID: 'test' };
    const output = { title: 'package-lock.json', output: 'done', metadata: {} };
    await hooks['tool.execute.after']!(input, output);
    expect(output.output).toBe('done');
  });
});
