import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from '../../skills/diagram/scripts/layout/build.ts';
import { carriedBy, CHARSET, METRICS_PATH, textWidth } from '../../skills/diagram/scripts/layout/measure.ts';
import { layout, MARGIN } from '../../skills/diagram/scripts/layout/geometry.ts';
import { fitScore } from '../../skills/diagram/scripts/orientation.ts';
import { parseSpec } from '../../skills/diagram/scripts/layout/spec.ts';

const EXAMPLES = join(import.meta.dir, '../../skills/diagram/examples');

// Two zones, a fan-out, a fan-in and a lone node: the shapes that collide when
// coordinates are placed by hand.
const FIXTURE = `
title: Fixture
direction: down
palette: dark
zones:
  - { id: edge, label: Edge }
  - { id: core, label: Core }
nodes:
  - { id: client, label: client, note: signs its request, role: start, shape: ellipse, zone: edge }
  - { id: gw, label: gateway, note: "POST /v1/answer", zone: edge }
  - { id: check, label: valid?, role: decision, shape: diamond, zone: core }
  - { id: deny, label: "401 bad_signature", role: error, mono: true, zone: core }
  - { id: plan, label: planner, note: picks the tool chain, role: agent, zone: core }
  - { id: out, label: answer, note: "audited, then streamed", role: success }
edges:
  - { from: client, to: gw, label: mTLS }
  - { from: gw, to: check }
  - { from: check, to: deny, label: "no", dashed: true, role: error }
  - { from: check, to: plan, label: "yes" }
  - { from: plan, to: out }
notes:
  - the gateway never sees a key
`;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// The rank table is a claim about left-to-right chains, so these pin the
// direction rather than letting the auto pass restack them.
function chain(ranks: number, direction = 'direction: right\n'): string {
  const nodes = Array.from({ length: ranks }, (_, i) => `{ id: n${i}, label: s${i} }`);
  const edges = 'edges:\n'
    + Array.from({ length: ranks - 1 }, (_, i) => `  - { from: n${i}, to: n${i + 1} }\n`).join('');
  return direction + specWith(nodes, edges);
}

function notedChain(ranks: number, direction = 'direction: right\n'): string {
  const nodes = Array.from(
    { length: ranks },
    (_, i) => `{ id: n${i}, label: step ${i}, note: a typical one-line note }`,
  );
  const edges = 'edges:\n'
    + Array.from({ length: ranks - 1 }, (_, i) => `  - { from: n${i}, to: n${i + 1} }\n`).join('');
  return direction + specWith(nodes, edges);
}

function specWith(nodes: string[], extra = ''): string {
  return `nodes:\n${nodes.map((n) => `  - ${n}\n`).join('')}${extra}`;
}

describe('layout geometry', () => {
  const placed = layout({ ...parseSpec(FIXTURE), direction: 'down' });
  const nodes = [...placed.nodes.values()];

  test('no two node bounds overlap', () => {
    const hits: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (overlap(nodes[i], nodes[j]) > 0) hits.push(`${nodes[i].spec.id}/${nodes[j].spec.id}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('a zone frame contains its own nodes and touches no others', () => {
    for (const [id, frame] of placed.zones) {
      for (const n of nodes) {
        const inside = n.x >= frame.x && n.y >= frame.y
          && n.x + n.width <= frame.x + frame.width && n.y + n.height <= frame.y + frame.height;
        if (n.spec.zone === id) expect(`${id}:${n.spec.id}:${inside}`).toBe(`${id}:${n.spec.id}:true`);
        else expect(`${id}:${n.spec.id}:${overlap(frame, n)}`).toBe(`${id}:${n.spec.id}:0`);
      }
    }
  });

  test('every box is wide enough for the text it holds', () => {
    for (const n of nodes) {
      const label = textWidth(n.spec.label, n.spec.mono ? 3 : 1, 16);
      const note = n.spec.note ? textWidth(n.spec.note, 1, 13) : 0;
      expect(`${n.spec.id}:${Math.max(label, note) <= n.width}`).toBe(`${n.spec.id}:true`);
    }
  });
});

describe('emitted scene', () => {
  const built = build(parseSpec(FIXTURE));
  const elements = built.scene.elements as Record<string, unknown>[];
  const byId = new Map(elements.map((e) => [e.id as string, e]));

  test('every arrow is bound at both ends, and both shapes list it back', () => {
    const arrows = elements.filter((e) => e.type === 'arrow');
    expect(arrows.length).toBe(5);
    for (const a of arrows) {
      const from = (a.startBinding as { elementId: string }).elementId;
      const to = (a.endBinding as { elementId: string }).elementId;
      for (const end of [from, to]) {
        const bound = (byId.get(end)?.boundElements ?? []) as { id: string }[];
        expect(`${a.id}->${end}:${bound.some((b) => b.id === a.id)}`).toBe(`${a.id}->${end}:true`);
      }
    }
  });

  test('the same spec lays out identically twice', () => {
    expect(JSON.stringify(build(parseSpec(FIXTURE)).scene)).toBe(JSON.stringify(built.scene));
  });

  test('a caption wider than the graph still fits the canvas', () => {
    const caption = 'a caption far longer than any of the boxes it sits underneath, by some margin';
    const wide = build(parseSpec(`nodes:\n  - { id: a, label: a }\nnotes:\n  - ${caption}\n`));
    const note = (wide.scene.elements as Record<string, unknown>[]).find((e) => e.id === 'note_0')!;
    expect((note.x as number) + (note.width as number)).toBeLessThanOrEqual(wide.width);
    expect(wide.width).toBeGreaterThan(400);
  });

  test('no text is placed outside the canvas', () => {
    for (const e of elements.filter((t) => t.type === 'text')) {
      const right = (e.x as number) + (e.width as number);
      expect(`${e.id}:${right <= built.width && (e.x as number) >= 0}`).toBe(`${e.id}:true`);
    }
  });
});

describe('the register budget is enforced, not suggested', () => {
  test('a fourth zone is refused', () => {
    const zones = ['a', 'b', 'c', 'd'].map((z) => `  - { id: ${z} }\n`).join('');
    const nodes = ['a', 'b', 'c', 'd'].map((z) => `{ id: n${z}, label: n, zone: ${z} }`);
    expect(() => parseSpec(`zones:\n${zones}${specWith(nodes)}`)).toThrow(/4 zones exceeds/);
  });

  test('a thirteenth node is refused', () => {
    const nodes = Array.from({ length: 13 }, (_, i) => `{ id: n${i}, label: n${i} }`);
    expect(() => parseSpec(specWith(nodes))).toThrow(/13 nodes exceeds/);
  });

  test('a run past the canvas ceiling names the way out', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => `{ id: n${i}, label: "a rather long node label ${i}" }`);
    const edges = 'edges:\n' + Array.from({ length: 5 }, (_, i) => `  - { from: n${i}, to: n${i + 1} }\n`).join('');
    expect(() => build(parseSpec(`direction: right\n${specWith(nodes, edges)}`))).toThrow(/past the 1200x1400 ceiling/);
  });

  // The reference doc's rank table is only true while these hold, and a wrong
  // number in it sent an author down the wrong remedy once already.
  test.each([
    [4, 896, false],
    [5, 1128, true],
  ])('a %i-rank chain of minimum-width boxes is %i px wide', (ranks, width, warns) => {
    const built = build(parseSpec(chain(ranks)));
    expect(built.width).toBe(width);
    expect(built.warnings.length > 0).toBe(warns);
  });

  test('a six-rank chain is refused, and the refusal names the restack', () => {
    expect(() => build(parseSpec(chain(6)))).toThrow(/1360x.*ceiling.*direction: down/s);
  });

  // The second row of the reference's rank table: a note makes every box 190px,
  // so both thresholds arrive a rank earlier than they do for bare labels.
  test('a four-rank chain of note-carrying boxes is 1096 px and warns', () => {
    const built = build(parseSpec(notedChain(4)));
    expect(built.width).toBe(1096);
    expect(built.warnings.join()).toMatch(/over the 1000px page budget/);
  });

  test('a five-rank chain of note-carrying boxes is refused at 1378 px', () => {
    expect(() => build(parseSpec(notedChain(5)))).toThrow(/1378x.*ceiling.*direction: down/s);
  });

  test('a figure past the page budget warns without failing', () => {
    const nodes = Array.from({ length: 3 }, (_, i) => `{ id: n${i}, label: "a rather long node label ${i}" }`);
    const edges = 'edges:\n' + Array.from({ length: 2 }, (_, i) => `  - { from: n${i}, to: n${i + 1} }\n`).join('');
    const spec = parseSpec(`direction: right\n${specWith(nodes, edges)}`);
    expect(build(spec).warnings.join()).toMatch(/over the 1000px page budget/);
  });
});

describe('a spec that names no direction is laid out both ways', () => {
  test('a chain the column cannot hold as a row is restacked as a column', () => {
    const built = build(parseSpec(chain(5, '')));
    expect(built.direction).toBe('down');
    expect(`${built.width}x${built.height}`).toBe('200x668');
    expect(built.evidence).toBe('orientation: down (200x668) beat right (1128x108)');
  });

  test('a chain that does fit the column keeps the row', () => {
    const built = build(parseSpec(chain(4, '')));
    expect(built.direction).toBe('right');
    expect(built.evidence).toBe('orientation: right (896x108) beat down (200x528)');
  });

  // The pick chooses between two layouts; it must not perturb the one it keeps.
  test('the chosen orientation draws the scene the explicit spec would', () => {
    const auto = build(parseSpec(chain(5, '')));
    const named = build(parseSpec(chain(5, 'direction: down\n')));
    expect(JSON.stringify(auto.scene)).toBe(JSON.stringify(named.scene));
  });

  test('an explicit direction is kept even when the other one scores better', () => {
    const built = build(parseSpec(chain(5)));
    expect({ direction: built.direction, width: built.width, evidence: built.evidence })
      .toEqual({ direction: 'right', width: 1128, evidence: undefined });
  });

  test('a direction the spec sets is honoured all the way to its refusal', () => {
    expect(() => build(parseSpec(chain(6)))).toThrow(/1360x.*ceiling.*direction: down/s);
  });

  test('an orientation refused as a row is drawn as a column instead', () => {
    const built = build(parseSpec(notedChain(5, '')));
    expect(built.direction).toBe('down');
    expect(built.evidence).toBe('orientation: down (250x768) — right does not fit');
  });

  test('a figure neither orientation can hold is refused, naming both', () => {
    let message = '';
    try {
      build(parseSpec(notedChain(9, '')));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('neither orientation fits');
    expect(message).toContain('as right: laid out at 2506x128, past the 1200x1400 ceiling');
    expect(message).toContain('as down: laid out at 250x1408, past the 1200x1400 ceiling');
    // The restack has already been tried, so it is not offered as the way out.
    expect(message).not.toContain('set direction: down');
  });

  test('the score prefers a column to a row the page would have to shrink', () => {
    // 977 px of column against 540 px of reading height: a strip that fits
    // wins, and one that must scale down loses to the column that does not.
    expect(fitScore(896, 108)).toBeLessThan(fitScore(200, 528));
    expect(fitScore(1128, 108)).toBeGreaterThan(fitScore(200, 668));
    expect(fitScore(5792, 1736)).toBeGreaterThan(fitScore(1221, 1787));
    expect(fitScore(0, 0)).toBe(Infinity);
  });
});

describe('a spec that cannot be drawn is refused, not drawn wrong', () => {
  test('a self-edge is refused: dagre routes it nowhere near its node', () => {
    expect(() => parseSpec(specWith(['{ id: a, label: retry }'], 'edges:\n  - { from: a, to: a }\n')))
      .toThrow(/edge from "a" to itself/);
  });

  test('a multi-line label gets a box tall enough to hold it', () => {
    const built = build(parseSpec('nodes:\n  - { id: a, label: "one\\ntwo\\nthree\\nfour" }\n'));
    const elements = built.scene.elements as Record<string, unknown>[];
    const box = elements.find((e) => e.id === 'a')!;
    const label = elements.find((e) => e.id === 'a__label')!;
    expect(label.height as number).toBeGreaterThan(60);
    expect((label.y as number) >= (box.y as number)).toBe(true);
    expect((label.y as number) + (label.height as number) <= (box.y as number) + (box.height as number)).toBe(true);
  });

  test('every element sits inside the canvas margins, text included', () => {
    // contentBounds covered the graph only, so a text element taller or wider
    // than its box escaped the margin the canvas was sized from.
    // The title and the notes are the elements that live outside every shape,
    // so they are the ones a graph-only bound leaves hanging off the canvas.
    const built = build(parseSpec(
      'title: a title much longer than the single box beneath it\n'
        + 'nodes:\n  - { id: a, label: "one\\ntwo\\nthree\\nfour", note: a long trailing note }\n'
        + 'notes:\n  - and a caption longer still, running past the right edge of that box\n',
    ));
    for (const e of (built.scene.elements as Record<string, unknown>[]).filter((el) => el.id !== 'backdrop')) {
      const inside = (e.x as number) >= MARGIN && (e.y as number) >= MARGIN
        && (e.x as number) + (e.width as number) <= built.width - MARGIN
        && (e.y as number) + (e.height as number) <= built.height - MARGIN;
      expect(`${e.id}:${inside}`).toBe(`${e.id}:true`);
    }
  });

  test('a character the metrics table does not cover is refused, not guessed', () => {
    // Substituting another glyph's advance measured "Zürich" NARROWER than
    // "Zurich", so the box came out too small for the text it holds.
    expect(() => parseSpec(specWith(['{ id: a, label: "日本語" }'])))
      .toThrow(/not in the font metrics table/);
  });
});

describe('spec validation', () => {
  test.each([
    ['an undeclared zone', '{ id: a, label: A, zone: nope }', /names zone "nope"/],
    ['a duplicate id', '{ id: a, label: A }\n  - { id: a, label: B }', /duplicate node id "a"/],
    // An unquoted comma turns the rest of a flow mapping into a stray key, and
    // silently dropped half a label before this check existed.
    ['an unquoted comma', '{ id: a, label: A, note: audited, then streamed }', /unknown key/],
    ['an unknown role', '{ id: a, label: A, role: purple }', /is not one of/],
  ])('%s is refused', (_name, node, message) => {
    expect(() => parseSpec(specWith([node]))).toThrow(message);
  });

  test('an edge to nowhere is refused', () => {
    expect(() => parseSpec(specWith(['{ id: a, label: A }'], 'edges:\n  - { from: a, to: b }\n')))
      .toThrow(/no node "b"/);
  });
});

describe('the reference doc matches the code', () => {
  // The reference hard-wraps its prose, so a remedy sentence spans lines there
  // and never matches the one-line string the code emits until both are flat.
  const reference = readFileSync(join(EXAMPLES, '../references/auto-layout.md'), 'utf-8')
    .replace(/\s+/g, ' ');
  const documents = (phrase: string) => `documented: ${reference.includes(phrase)}`;

  // A number in that file went stale once and sent an author down the wrong
  // remedy, so the strings an author is told to look for are pinned here.
  test.each([
    ['a node label may reach the mono font', '{ id: a, label: "a \u2192 b" }', 'the mono font (mono: true) carries it'],
    // These five are rendered in the hand-drawn font with no way to ask for the
    // other one, so telling them to set mono: true dead-ends the author.
    ['a note may not', '{ id: a, label: A, note: "a \u2192 b" }', 'a note cannot ask for it, so write it in words'],
    ['a glyph nothing carries', '{ id: a, label: "a \u21d2 b" }', 'no font in the output carries it, so write it in words'],
  ])('%s', (_name, node, remedy) => {
    let message = '';
    try {
      parseSpec(specWith([node]));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(remedy);
    expect(documents(remedy)).toBe('documented: true');
  });

  test.each([
    ['a title', 'title: "a \u2192 b"\nnodes:\n  - { id: a, label: A }\n'],
    ['a zone label', 'zones:\n  - { id: z, label: "a \u2192 b" }\nnodes:\n  - { id: a, label: A, zone: z }\n'],
    ['an edge label', 'nodes:\n  - { id: a, label: A }\n  - { id: b, label: B }\n'
      + 'edges:\n  - { from: a, to: b, label: "a \u2192 b" }\n'],
    ['a caption', 'nodes:\n  - { id: a, label: A }\nnotes:\n  - "a \u2192 b"\n'],
  ])('%s is told to write it in words, never to set mono: true', (kind, spec) => {
    let message = '';
    try {
      parseSpec(spec);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`${kind} cannot ask for it, so write it in words`);
    expect(message).not.toContain('mono: true');
  });

  // The evidence lines are the only report of a choice the author did not make,
  // so the doc quotes them verbatim and this keeps the quote true.
  test('the reference quotes the orientation lines the run actually prints', () => {
    for (const spec of [chain(5, ''), notedChain(5, '')]) {
      expect(documents(build(parseSpec(spec)).evidence!)).toBe('documented: true');
    }
  });

  test('the rank table quotes the widths both chains actually produce', () => {
    for (const [ranks, width] of [[4, 896], [5, 1128]] as const) {
      expect(`${ranks}:${build(parseSpec(chain(ranks))).width}`).toBe(`${ranks}:${width}`);
    }
    expect(build(parseSpec(notedChain(4))).width).toBe(1096);
    for (const width of [896, 1128, 1360, 1096, 1378]) expect(documents(`${width} px`)).toBe('documented: true');
  });
});

describe('committed example', () => {
  const spec = readFileSync(join(EXAMPLES, 'sketch-pipeline.diagram.yaml'), 'utf-8');

  test('it still lays out to the committed scene', () => {
    const fresh = `${JSON.stringify(build(parseSpec(spec)).scene, null, 1)}\n`;
    expect(fresh).toBe(readFileSync(join(EXAMPLES, 'sketch-pipeline.excalidraw'), 'utf-8'));
  });

  test('its committed SVG carries no CDN reference and no runtime', () => {
    const svg = readFileSync(join(EXAMPLES, 'sketch-pipeline.svg'), 'utf-8');
    expect(svg).toContain('@font-face');
    expect(svg).toContain('data:font/woff2;base64,');
    expect(svg).not.toContain('<script');
    expect(svg.match(/https?:\/\/(?!www\.w3\.org)/)).toBeNull();
  });
});

describe('font metrics', () => {
  const table = JSON.parse(readFileSync(METRICS_PATH, 'utf-8')) as {
    unit: number;
    families: Record<string, Record<string, number>>;
  };

  test('both measured families cover printable ASCII', () => {
    const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
    expect(Object.keys(table.families).sort()).toEqual(['1', '3']);
    for (const [family, widths] of Object.entries(table.families)) {
      const missing = ascii.filter((c) => typeof widths[c] !== 'number');
      expect(`${family}:${missing.join('')}`).toBe(`${family}:`);
    }
  });

  test('the table holds only characters the charset offered', () => {
    // The generator keeps a glyph only when the embedded faces really carry it,
    // so the table is a subset of CHARSET and never a superset.
    const offered = new Set([...CHARSET]);
    for (const [family, widths] of Object.entries(table.families)) {
      const stray = Object.keys(widths).filter((c) => !offered.has(c));
      expect(`${family}:${stray.join('')}`).toBe(`${family}:`);
    }
  });

  test('a glyph no font carries is reported as carried by nothing', () => {
    expect(carriedBy('\u65e5')).toEqual([]);
    expect(carriedBy('a')).toEqual([1, 3]);
  });
});
