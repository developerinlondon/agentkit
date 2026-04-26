import { describe, test, expect } from 'bun:test';
import {
  findCommentBlocks,
  commentLineCount,
  codeLineCount,
  checkBlocks,
  checkRatio,
} from '../plugins/comment-police';

const TS = /^\s*\/\//;
const PY = /^\s*#(?!!)/;

describe('findCommentBlocks', () => {
  test('groups consecutive line comments', () => {
    const src = ['// a', '// b', '// c', 'const x = 1;', '// d'];
    const blocks = findCommentBlocks(src, TS);
    expect(blocks.length).toBe(2);
    expect(blocks[0].lines.length).toBe(3);
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[1].lines.length).toBe(1);
    expect(blocks[1].startLine).toBe(5);
  });

  test('returns empty array when no comments', () => {
    const src = ['const x = 1;', 'const y = 2;'];
    expect(findCommentBlocks(src, TS)).toEqual([]);
  });

  test('handles trailing comment block', () => {
    const src = ['const x = 1;', '// trailing', '// trailing'];
    const blocks = findCommentBlocks(src, TS);
    expect(blocks.length).toBe(1);
    expect(blocks[0].lines.length).toBe(2);
  });
});

describe('checkBlocks', () => {
  const blockOf = (n: number, startLine: number) => ({
    startLine,
    lines: Array.from({ length: n }, (_, i) => `// line ${i}`),
  });

  test('warns on long body block', () => {
    const warnings = checkBlocks([blockOf(7, 30)], 6, 10, []);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('long comment block');
    expect(warnings[0]).toContain('line 30');
  });

  test('does not warn on body block within limit', () => {
    expect(checkBlocks([blockOf(6, 30)], 6, 10, [])).toEqual([]);
  });

  test('warns on tutorial header (block within first 3 lines)', () => {
    const warnings = checkBlocks([blockOf(11, 1)], 6, 10, []);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('tutorial-style file header');
  });

  test('header threshold is more permissive than body', () => {
    expect(checkBlocks([blockOf(10, 1)], 6, 10, [])).toEqual([]);
    const w = checkBlocks([blockOf(7, 5)], 6, 10, []);
    expect(w.length).toBe(1);
    expect(w[0]).toContain('long comment block');
  });

  test('flags rotting reference patterns (PR / plan / closes)', () => {
    const block = {
      startLine: 5,
      lines: ['// closes #76 — wires the auth gate'],
    };
    const warnings = checkBlocks([block], 6, 10, [/closes\s*#\d+/i]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('rotting reference');
    expect(warnings[0]).toContain('closes #76');
  });

  test('only flags first matching forbidden pattern per block', () => {
    const block = {
      startLine: 5,
      lines: ['// closes #1', '// see PR #2'],
    };
    const warnings = checkBlocks([block], 6, 10, [
      /closes\s*#\d/i,
      /PR\s*#\d/i,
    ]);
    expect(warnings.length).toBe(1);
  });
});

describe('checkRatio', () => {
  test('returns null for empty file', () => {
    expect(checkRatio([], TS, 0.3)).toBeNull();
  });

  test('returns null when ratio is under threshold', () => {
    const src = [
      '// a',
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
    ];
    expect(checkRatio(src, TS, 0.3)).toBeNull();
  });

  test('warns when comments dominate', () => {
    const src = [
      '// 1',
      '// 2',
      '// 3',
      '// 4',
      '// 5',
      '// 6',
      'const x = 1;',
    ];
    const warning = checkRatio(src, TS, 0.3);
    expect(warning).not.toBeNull();
    expect(warning).toContain('exceeds 30%');
    expect(warning).toContain('6 comment lines vs 1 code lines');
  });

  test('python comments via the # marker', () => {
    const src = [
      '# header',
      '# header',
      '# header',
      '# header',
      'x = 1',
    ];
    const warning = checkRatio(src, PY, 0.3);
    expect(warning).not.toBeNull();
  });
});

describe('commentLineCount + codeLineCount', () => {
  test('counts each separately, ignoring blank lines for code', () => {
    const src = ['// a', '', 'const x = 1;', 'const y = 2;', '// b'];
    expect(commentLineCount(src, TS)).toBe(2);
    expect(codeLineCount(src, TS)).toBe(2);
  });
});
