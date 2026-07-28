import { describe, expect, test } from 'bun:test';
import {
  assertDensity,
  emit,
  ExtractError,
  type Graph,
  idAssigner,
  quote,
  RESERVED_WORDS,
  slug,
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

  test('a D2 keyword is reserved in the spelling slug() emits, not D2\'s', () => {
    expect(slug('style')).toBe('style_');
    expect(slug('grid-rows')).toBe('grid_rows');
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

describe('dollar escaping', () => {
  test('a dollar is escaped — d2 substitutes ${...} inside double quotes too', () => {
    // Without this the render dies on a variable nothing declared, and the one
    // function every extractor trusts for safety has a hole in it.
    expect(quote('/data/${ENV}/x')).toBe('"/data/\\${ENV}/x"');
    expect(quote('cost $5')).toBe('"cost \\$5"');
  });

  test('a backslash already present is not confused with the escapes added after it', () => {
    expect(quote('a\\${x}')).toBe('"a\\\\\\${x}"');
  });
});

describe('the reserved-keyword list', () => {
  test('every entry is one slug() can actually emit', () => {
    // The list guards slug() output, so an entry slug() can never produce is
    // cover that is not there — d2's hyphenated spellings do not survive it.
    for (const word of RESERVED_WORDS) {
      expect(slug(word)).toBe(`${word}_`);
    }
  });

  test('the D2 keywords that can collide are covered', () => {
    for (const word of ['style', 'shape', 'icon', 'label', 'near', 'direction', 'vars', 'steps']) {
      expect(RESERVED_WORDS).toContain(word);
    }
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

  test('two containers sharing an id are refused — d2 would merge them silently', () => {
    // The damaging case: d2 merges same-key blocks and the last label wins, so
    // one container disappears and its children are shown inside the other.
    const bad = graph({
      zones: [{ id: 'a_b', label: 'a-b' }, { id: 'a_b', label: 'a_b' }],
      nodes: [{ id: 'n', label: 'N', zone: 'a_b' }],
    });
    expect(() => emit(bad, 'test')).toThrow(/duplicate container id "a_b"/);
    // Both names appear, so the reader knows which two collided.
    expect(() => emit(bad, 'test')).toThrow(/"a_b" collides with "a-b"/);
  });

  test('a container and a node cannot share an id either — one key namespace', () => {
    const bad = graph({
      zones: [{ id: 'shared', label: 'Z' }],
      nodes: [{ id: 'shared', label: 'N' }],
    });
    expect(() => emit(bad, 'test')).toThrow(/duplicate node id "shared"/);
  });

  test('an assigner keeps names that slug alike distinct', () => {
    const assign = idAssigner();
    expect([assign('a-b'), assign('a_b'), assign('a.b')]).toEqual(['a_b', 'a_b_2', 'a_b_3']);
  });

  test('a provenance line cannot end its comment and become source', () => {
    const out = emit(graph({ nodes: [{ id: 'a', label: 'A' }] }), 'derived\nINJECTED: "PWNED"');
    expect(out.split('\n')[0]).toBe('# derived INJECTED: "PWNED"');
    expect(out.split('\n').filter((l) => l.includes('INJECTED'))).toHaveLength(1);
  });

  test('shape and icon are constrained, since neither can be quoted', () => {
    const bad = (over: Record<string, string>) =>
      graph({ nodes: [{ id: 'a', label: 'A', ...over }] });
    expect(() => emit(bad({ shape: 'circle' }), 'test')).not.toThrow();
    expect(() => emit(bad({ shape: 'circle\nINJ: "x"' }), 'test')).toThrow(/unusable shape/);
    expect(() => emit(bad({ icon: 'aws-rds' }), 'test')).not.toThrow();
    expect(() => emit(bad({ icon: 'x\n}\nINJ: "y"' }), 'test')).toThrow(/unusable icon/);
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
