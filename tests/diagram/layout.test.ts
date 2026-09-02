import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from '../../skills/diagram/scripts/layout/build.ts';
import { CHARSET, METRICS_PATH, textWidth } from '../../skills/diagram/scripts/layout/measure.ts';
import { layout } from '../../skills/diagram/scripts/layout/geometry.ts';
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

function specWith(nodes: string[], extra = ''): string {
  return `nodes:\n${nodes.map((n) => `  - ${n}\n`).join('')}${extra}`;
}

describe('layout geometry', () => {
  const placed = layout(parseSpec(FIXTURE));
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
    expect(() => build(parseSpec(specWith(nodes, edges)))).toThrow(/past the 1200x1400 ceiling/);
  });

  test('a figure past the page budget warns without failing', () => {
    const nodes = Array.from({ length: 3 }, (_, i) => `{ id: n${i}, label: "a rather long node label ${i}" }`);
    const edges = 'edges:\n' + Array.from({ length: 2 }, (_, i) => `  - { from: n${i}, to: n${i + 1} }\n`).join('');
    expect(build(parseSpec(specWith(nodes, edges))).warnings.join()).toMatch(/over the 1000px page budget/);
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
  test('the table covers every character the charset promises', () => {
    const table = JSON.parse(readFileSync(METRICS_PATH, 'utf-8')) as {
      unit: number;
      families: Record<string, Record<string, number>>;
    };
    expect(Object.keys(table.families).sort()).toEqual(['1', '3']);
    for (const [family, widths] of Object.entries(table.families)) {
      const missing = [...CHARSET].filter((c) => typeof widths[c] !== 'number');
      expect(`${family}:${missing.join('')}`).toBe(`${family}:`);
    }
  });
});
