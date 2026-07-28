import { describe, expect, test } from 'bun:test';
import {
  assertDensity,
  emit,
  ExtractError,
  type Graph,
  quote,
  slug,
  uniqueSlug,
} from '../../skills/diagram/scripts/extract/model.ts';

const graph = (over: Partial<Graph> = {}): Graph => ({ zones: [], nodes: [], edges: [], ...over });

describe('identifier slugging', () => {
  test('a D2 keyword is pushed out of the way rather than declared as a key', () => {
    // `style: {...}` on a container configures that container instead of
    // declaring a child, so a directory called `style` would silently vanish.
    for (const reserved of ['style', 'shape', 'label', 'steps', 'link', 'class', 'near']) {
      expect(slug(reserved)).toBe(`${reserved}_`);
    }
  });

  test('separators and case collapse to one safe form', () => {
    expect(slug('skills/diagram/scripts')).toBe('skills_diagram_scripts');
    expect(slug('@sindresorhus/is')).toBe('sindresorhus_is');
    expect(slug('node builtins')).toBe('node_builtins');
  });

  test('a leading digit is prefixed — D2 keys may not start with one', () => {
    expect(slug('3rd-party')).toBe('n_3rd_party');
  });

  test('an all-separator name still yields a usable key', () => {
    expect(slug('///')).toBe('n');
  });

  test('distinct inputs that slug alike are kept distinct', () => {
    const taken = new Set<string>();
    expect(uniqueSlug('a/b', taken)).toBe('a_b');
    expect(uniqueSlug('a-b', taken)).toBe('a_b_2');
    expect(uniqueSlug('a.b', taken)).toBe('a_b_3');
  });
});

describe('label quoting', () => {
  test('structural characters cannot escape the label', () => {
    const out = quote('a: b {c} [d] # e; f | g');
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(out).toContain('a: b {c}');
  });

  test('an embedded quote is escaped rather than closing the string', () => {
    expect(quote('say "hi"')).toBe('"say \\"hi\\""');
  });

  test('a backslash is escaped before anything else consumes it', () => {
    expect(quote('C:\\path')).toBe('"C:\\\\path"');
  });

  test('every newline form becomes D2\'s two-character break', () => {
    expect(quote('a\nb')).toBe('"a\\nb"');
    expect(quote('a\r\nb')).toBe('"a\\nb"');
    expect(quote('a\rb')).toBe('"a\\nb"');
  });

  test('control characters are stripped, not passed through', () => {
    expect(quote('a\u0000b\u001fc\u007f')).toBe('"a b c "');
  });
});

describe('density budget', () => {
  const wide = graph({ nodes: Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, label: `n${i}` })) });

  test('a figure past the budget is refused, naming the count and the lever', () => {
    expect(() => assertDensity(wide, 12, '--focus a subtree')).toThrow(ExtractError);
    expect(() => assertDensity(wide, 12, '--focus a subtree')).toThrow(/13 nodes.*12.*--focus a subtree/s);
  });

  test('the budget is inclusive at its stated limit', () => {
    expect(() => assertDensity(wide, 13, 'lever')).not.toThrow();
  });
});

describe('D2 emission', () => {
  test('a node inside nested zones is addressed by its full path', () => {
    const out = emit(
      graph({
        zones: [{ id: 'outer', label: 'Outer' }, { id: 'inner', label: 'Inner', parent: 'outer' }],
        nodes: [{ id: 'a', label: 'A', zone: 'inner' }, { id: 'b', label: 'B' }],
        edges: [{ from: 'b', to: 'a', label: 'calls' }],
      }),
      'test',
    );
    expect(out).toContain('b -> outer.inner.a: "calls"');
    expect(out).toContain('  inner: "Inner" {');
  });

  test('an edge naming a node that was never declared fails the emit', () => {
    const bad = graph({ nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'ghost' }] });
    expect(() => emit(bad, 'test')).toThrow(/undeclared node/);
  });

  test('two nodes sharing an id are refused — the second would silently win', () => {
    const bad = graph({ nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] });
    expect(() => emit(bad, 'test')).toThrow(/duplicate node id/);
  });

  test('node attributes land inside the node block, not beside it', () => {
    const out = emit(
      graph({ nodes: [{ id: 'a', label: 'A', tech: 'ts', icon: 'postgres', multiple: true }] }),
      'test',
    );
    expect(out).toContain('a: "A\\nts" {');
    expect(out).toContain('  icon: @postgres');
    expect(out).toContain('  style.multiple: true');
  });

  test('the provenance line leads the file and names no filesystem path', () => {
    const out = emit(graph({ nodes: [{ id: 'a', label: 'A' }] }), 'derived from X — 1 nodes, 0 edges');
    expect(out.split('\n')[0]).toBe('# derived from X — 1 nodes, 0 edges');
    expect(out).not.toContain('/');
  });

  test('a cyclic zone parent chain terminates instead of hanging', () => {
    const out = emit(
      graph({
        zones: [{ id: 'a', label: 'A', parent: 'b' }, { id: 'b', label: 'B', parent: 'a' }],
        nodes: [{ id: 'n', label: 'N', zone: 'a' }],
      }),
      'test',
    );
    expect(out).toContain('n');
  });
});
