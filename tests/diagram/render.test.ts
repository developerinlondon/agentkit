import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D2_PIN } from '../../skills/diagram/scripts/d2-svg.ts';
import { declaresDirection, withDirection } from '../../skills/diagram/scripts/orientation.ts';

const wrapper = join(import.meta.dir, '../../skills/diagram/scripts/d2-render.ts');
const SOURCE = 'a: API {\n  icon: @postgres\n}\nb: Worker\na -> b: enqueue\n';

interface Run {
  code: number;
  stderr: string;
}

// Seven nodes in a line: a strip left to right, a column top to bottom.
const CHAIN = ['source', 'ingest', 'queue', 'worker', 'store', 'index', 'serve'];
const UNDIRECTED = CHAIN.map((n) => `${n}: ${n} stage\n`).join('')
  + CHAIN.slice(1).map((n, i) => `${CHAIN[i]} -> ${n}: step\n`).join('');

function viewBox(file: string): { width: number; height: number } {
  const box = readFileSync(file, 'utf-8').match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  return { width: Number(box?.[1]), height: Number(box?.[2]) };
}

function run(dir: string, args: string[], path?: string, extra: Record<string, string> = {}): Run {
  const base = { ...process.env };
  // A case that pins PATH is testing PATH discovery, and an ambient D2_BIN would
  // answer for it. Every other case renders with whatever binary the operator
  // pointed the wrapper at, D2_BIN included.
  if (path !== undefined) {
    delete base.D2_BIN;
    base.PATH = path;
  }
  const result = Bun.spawnSync({
    cmd: [process.execPath, wrapper, ...args],
    cwd: dir,
    env: { ...base, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

// A stub keeps the pin check honest on a machine that has the real binary.
function stubD2(dir: string, version: string, renderExit = 1): string {
  const bin = join(dir, 'bin');
  Bun.spawnSync({ cmd: ['mkdir', '-p', bin] });
  const exe = join(bin, 'd2');
  writeFileSync(
    exe,
    `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}" && exit 0\nexit ${renderExit}\n`,
  );
  chmodSync(exe, 0o755);
  return bin;
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'd2-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stageSource(dir: string): { src: string; out: string } {
  const src = join(dir, 'a.d2');
  writeFileSync(src, SOURCE);
  return { src, out: join(dir, 'a.svg') };
}

// Bun.spawnSync throws ENOENT for a missing executable rather than reporting a
// non-zero exit, which would crash this file instead of skipping it. D2_BIN is
// honoured here for the same reason the wrapper honours it: a candidate build
// is tested without displacing the binary the rest of the machine renders with.
const candidate = process.env.D2_BIN;
const available = candidate === undefined ? Bun.which('d2') !== null : existsSync(candidate);
if (!available) {
  console.error(
    `SKIPPED tests/diagram/render.test.ts: no d2 on PATH and no D2_BIN — the render, `
      + `icon-embedding, self-containment and committed-example cases did NOT run. This skill `
      + `pins d2 v${D2_PIN}; CI installs it in .github/workflows/ci.yml.`,
  );
}

describe('d2 version pin', () => {
  test('a mismatched d2 is refused, naming the pin and where to get it', () => {
    withTemp((dir) => {
      writeFileSync(join(dir, 'a.d2'), 'x: y\n');
      const result = run(dir, ['--in', join(dir, 'a.d2')], stubD2(dir, 'v0.6.0'));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('v0.6.0');
      expect(result.stderr).toContain(D2_PIN);
      expect(result.stderr).toContain('github.com/d2lang/d2/releases');
    });
  });

  test('an absent d2 is refused rather than silently skipped', () => {
    withTemp((dir) => {
      writeFileSync(join(dir, 'a.d2'), 'x: y\n');
      const result = run(dir, ['--in', join(dir, 'a.d2')], join(dir, 'empty'));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('d2 not found');
      expect(result.stderr).toContain(D2_PIN);
    });
  });

  test('the pinned version is accepted', () => {
    withTemp((dir) => {
      writeFileSync(join(dir, 'a.d2'), 'x: y\n');
      // The stub renders nothing, so this fails at compile, not at the pin.
      const result = run(dir, ['--in', join(dir, 'a.d2')], stubD2(dir, `v${D2_PIN}`));
      expect(result.stderr).not.toContain('pins v');
      expect(result.stderr).toContain('failed to compile');
    });
  });

  test('D2_BIN supplies the binary when PATH does not', () => {
    withTemp((dir) => {
      writeFileSync(join(dir, 'a.d2'), 'x: y\n');
      const bin = join(stubD2(dir, `v${D2_PIN}`), 'd2');
      const result = run(dir, ['--in', join(dir, 'a.d2')], join(dir, 'empty'), { D2_BIN: bin });
      expect(result.stderr).not.toContain('d2 not found');
      expect(result.stderr).toContain('failed to compile');
    });
  });

  test('a mismatched D2_BIN is refused, naming the override rather than PATH', () => {
    withTemp((dir) => {
      writeFileSync(join(dir, 'a.d2'), 'x: y\n');
      const bin = join(stubD2(dir, 'v0.6.0'), 'd2');
      const result = run(dir, ['--in', join(dir, 'a.d2')], join(dir, 'empty'), { D2_BIN: bin });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`D2_BIN=${bin}`);
      expect(result.stderr).toContain('v0.6.0');
      expect(result.stderr).not.toContain('on PATH');
    });
  });

  test('a d2 that exits clean without writing an SVG is named, not an ENOENT', () => {
    withTemp((dir) => {
      writeFileSync(join(dir, 'a.d2'), 'x: y\n');
      const result = run(dir, ['--in', join(dir, 'a.d2')], stubD2(dir, `v${D2_PIN}`, 0));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('wrote no SVG');
      expect(result.stderr).not.toContain('ENOENT');
    });
  });

  test('a missing input file is refused before d2 is consulted', () => {
    withTemp((dir) => {
      expect(run(dir, ['--in', join(dir, 'nope.d2')]).stderr).toContain('no such file');
    });
  });

  test('every CI job that runs the suite installs exactly the pinned d2', () => {
    // A job without the install step skips the render tests silently; one that
    // installs a different build hits the wrapper's refusal instead of testing.
    const ci = readFileSync(join(import.meta.dir, '../../.github/workflows/ci.yml'), 'utf-8');
    const installed = [...ci.matchAll(/install-d2\s*\n\s*with:\s*\n\s*version:\s*(\S+)/g)].map((m) => m[1]);
    const suiteRuns = [...ci.matchAll(/moon (?:ci|run) agentkit:test-full/g)].length;
    expect(suiteRuns).toBeGreaterThan(0);
    expect(installed.length).toBe(suiteRuns);
    for (const version of installed) expect(version).toBe(D2_PIN);
  });
});

describe.if(available)('rendering with the pinned d2', () => {
  test('the same source renders byte-identically twice', () => {
    withTemp((dir) => {
      const src = join(dir, 'a.d2');
      writeFileSync(src, SOURCE);
      for (const out of ['one.svg', 'two.svg']) {
        expect(run(dir, ['--in', src, '--out', join(dir, out)]).code).toBe(0);
      }
      expect(readFileSync(join(dir, 'one.svg'))).toEqual(readFileSync(join(dir, 'two.svg')));
    });
  });

  test('a referenced icon is embedded as data, with no path left behind', () => {
    withTemp((dir) => {
      const { src, out } = stageSource(dir);
      expect(run(dir, ['--in', src, '--out', out]).code).toBe(0);
      const svg = readFileSync(out, 'utf-8');
      expect(svg).toContain('href="data:image/svg+xml;base64,');
      expect(svg).not.toContain('assets/iconify');
      expect(svg).not.toContain('.svg"');
    });
  });

  test('output is self-contained, house-attributed and theme-switchable', () => {
    withTemp((dir) => {
      const { src, out } = stageSource(dir);
      expect(run(dir, ['--in', src, '--out', out, '--label', 'a caption']).code).toBe(0);
      const svg = readFileSync(out, 'utf-8');
      expect(svg).toContain('svg-source:d2');
      expect(svg).toContain('aria-label="a caption"');
      expect(svg).toContain('html:not([data-theme="light"])');
      expect(svg).not.toContain('prefers-color-scheme');
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('<foreignObject');
      expect(svg.match(/https?:\/\/(?!www\.w3\.org)/)).toBeNull();
    });
  });

  test('the inlined stylesheet scopes bare element rules under the figure carrier', () => {
    withTemp((dir) => {
      const { src, out } = stageSource(dir);
      expect(run(dir, ['--in', src, '--out', out]).code).toBe(0);
      const svg = readFileSync(out, 'utf-8');
      const carrier = svg.match(/<svg class="(d2-\d+) d2-svg"/);
      expect(carrier).not.toBeNull();
      const scoped = `.${carrier?.[1]} .shape{`;
      expect(svg).toContain(scoped);
      expect(svg.split('.shape{').length - 1).toBe(svg.split(scoped).length - 1);
    });
  });

  test('--host class emits html.dark instead of the data-theme attribute guard', () => {
    withTemp((dir) => {
      const { src, out } = stageSource(dir);
      expect(run(dir, ['--in', src, '--out', out, '--host', 'class']).code).toBe(0);
      const svg = readFileSync(out, 'utf-8');
      expect(svg).toContain('html.dark');
      expect(svg).not.toContain('data-theme');
    });
  });

  test('an unknown --host value is refused, naming the two it accepts', () => {
    withTemp((dir) => {
      const src = join(dir, 'a.d2');
      writeFileSync(src, SOURCE);
      const result = run(dir, ['--in', src, '--out', join(dir, 'a.svg'), '--host', 'iframe']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('"attribute" or "class"');
    });
  });

  test('a second figure on the same page cannot pick up the first one\'s .shape rule', () => {
    withTemp((dir) => {
      const srcA = join(dir, 'a.d2');
      const srcB = join(dir, 'b.d2');
      writeFileSync(srcA, 'x -> y: hello\n');
      writeFileSync(srcB, 'p -> q: world\n');
      const outA = join(dir, 'a.svg');
      const outB = join(dir, 'b.svg');
      expect(run(dir, ['--in', srcA, '--out', outA, '--salt', 'figure-a']).code).toBe(0);
      expect(run(dir, ['--in', srcB, '--out', outB, '--salt', 'figure-b']).code).toBe(0);
      const svgA = readFileSync(outA, 'utf-8');
      const svgB = readFileSync(outB, 'utf-8');
      const carrierA = svgA.match(/<svg class="(d2-\d+) d2-svg"/)?.[1];
      const carrierB = svgB.match(/<svg class="(d2-\d+) d2-svg"/)?.[1];
      expect({ carrierA, carrierB }).not.toEqual({ carrierA: undefined, carrierB: undefined });
      expect(carrierA).not.toBe(carrierB);
      // Without scoping both figures would emit the identical bare `.shape{…}`
      // rule — one page carrying both would have whichever renders last apply
      // to shapes in both, which is exactly the collision the carrier prevents.
      expect(svgA).toContain(`.${carrierA} .shape{`);
      expect(svgB).toContain(`.${carrierB} .shape{`);
      expect(svgA).not.toContain(`.${carrierB}`);
      expect(svgB).not.toContain(`.${carrierA}`);
    });
  }, 30000);

  test('an unknown icon fails the render instead of dropping the glyph', () => {
    withTemp((dir) => {
      const src = join(dir, 'a.d2');
      writeFileSync(src, 'a: X {\n  icon: @no-such-icon\n}\n');
      const result = run(dir, ['--in', src, '--out', join(dir, 'a.svg')]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('unknown icon');
    });
  });

  test('a source naming no direction is laid out both ways, and the column kept', () => {
    withTemp((dir) => {
      const src = join(dir, 'chain.d2');
      writeFileSync(src, UNDIRECTED);
      const first = run(dir, ['--in', src, '--out', join(dir, 'one.svg')]);
      expect(first.code).toBe(0);
      const evidence = first.stderr.match(/orientation: down \((\d+)x(\d+)\) beat right \((\d+)x(\d+)\)/);
      expect(`evidence: ${first.stderr.trim()}`).toBe(`evidence: d2-render: ${evidence?.[0]}`);
      const [downW, downH, rightW, rightH] = evidence!.slice(1).map(Number);
      expect(`down ${downH > downW}, right ${rightW > rightH}`).toBe('down true, right true');
      expect(viewBox(join(dir, 'one.svg'))).toEqual({ width: downW, height: downH });
      // The pick renders twice; the output still has to be the same bytes twice.
      expect(run(dir, ['--in', src, '--out', join(dir, 'two.svg')]).code).toBe(0);
      expect(readFileSync(join(dir, 'one.svg'))).toEqual(readFileSync(join(dir, 'two.svg')));
    });
  }, 30000);

  test('a direction the source sets is never overridden, by the pick or by the flag', () => {
    withTemp((dir) => {
      const src = join(dir, 'chain.d2');
      writeFileSync(src, `direction: right\n${UNDIRECTED}`);
      const plain = run(dir, ['--in', src, '--out', join(dir, 'plain.svg')]);
      const forced = run(dir, ['--in', src, '--out', join(dir, 'forced.svg'), '--direction', 'down']);
      expect({ plain: plain.code, forced: forced.code }).toEqual({ plain: 0, forced: 0 });
      expect(plain.stderr).not.toContain('orientation:');
      expect(forced.stderr).toContain('--direction down ignored');
      expect(readFileSync(join(dir, 'plain.svg'))).toEqual(readFileSync(join(dir, 'forced.svg')));
      const box = viewBox(join(dir, 'plain.svg'));
      expect(box.width).toBeGreaterThan(box.height);
    });
  }, 30000);

  test('--direction hand-picks the orientation the pick would not have chosen', () => {
    withTemp((dir) => {
      const src = join(dir, 'chain.d2');
      writeFileSync(src, UNDIRECTED);
      const picked = run(dir, ['--in', src, '--out', join(dir, 'auto.svg')]);
      const forced = run(dir, ['--in', src, '--out', join(dir, 'right.svg'), '--direction', 'right']);
      expect({ picked: picked.code, forced: forced.code }).toEqual({ picked: 0, forced: 0 });
      expect(forced.stderr).not.toContain('orientation:');
      const box = viewBox(join(dir, 'right.svg'));
      expect(box.width).toBeGreaterThan(box.height);
      expect(readFileSync(join(dir, 'right.svg'), 'utf-8')).not.toBe(readFileSync(join(dir, 'auto.svg'), 'utf-8'));
    });
  }, 30000);

  test('an unknown --direction value is refused, naming the three it accepts', () => {
    withTemp((dir) => {
      const src = join(dir, 'a.d2');
      writeFileSync(src, SOURCE);
      const result = run(dir, ['--in', src, '--out', join(dir, 'a.svg'), '--direction', 'sideways']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('"right", "down" or "auto"');
    });
  });

  test('a markdown block is refused — it emits foreignObject and does not travel', () => {
    withTemp((dir) => {
      const src = join(dir, 'a.d2');
      writeFileSync(src, 'title: |md\n  # hi\n| {\n  near: top-center\n}\na -> b\n');
      const result = run(dir, ['--in', src, '--out', join(dir, 'a.svg')]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('foreignObject');
    });
  });
});

describe('reading the direction a d2 source already sets', () => {
  test.each([
    ['a board-level line', 'direction: down\na -> b\n', true],
    ['one indented with the rest of the file', '  direction: down\n  a -> b\n', true],
    ['a container\'s own, on its own line', 'x: {\n  direction: down\n}\n', false],
    ['a container\'s own, inline', 'x: { direction: down }\ny -> z\n', false],
    // A hex fill read as a comment would swallow the closing brace, and every
    // line after it would look nested — including a real board direction.
    ['one after a quoted hex fill', 'x: { style.fill: "#f00" }\ndirection: down\n', true],
    ['none at all', 'a -> b: hello\n', false],
  ])('%s', (_name, source, expected) => {
    expect(declaresDirection(source)).toBe(expected);
  });

  test('the injected line is appended, so d2 error line numbers still point at the source', () => {
    expect(withDirection('a -> b\n', 'down')).toBe('a -> b\ndirection: down\n');
    expect(withDirection('a -> b', 'right')).toBe('a -> b\ndirection: right\n');
  });
});

describe.if(available)('committed examples', () => {
  const examples = join(import.meta.dir, '../../skills/diagram/examples');

  test.each(['deployment-topology', 'c4-container', 'erd'])('%s is committed self-contained', (name) => {
    const svg = readFileSync(join(examples, `${name}.svg`), 'utf-8');
    expect(svg).toContain('svg-source:d2');
    expect(svg).toContain('class="d2"');
    expect(svg).not.toContain('<foreignObject');
    expect(svg).not.toContain('<script');
    expect(svg.match(/https?:\/\/(?!www\.w3\.org)/)).toBeNull();
  });

  // Three d2 subprocess renders in one test. Locally that is ~2.1s, but a
  // shared hosted runner has cleared 5s only by margin — a timeout here reports
  // as exit code null, which reads as a render failure rather than as slowness.
  test('the committed SVGs match a fresh render of their source', () => {
    withTemp((dir) => {
      for (const name of ['deployment-topology', 'c4-container', 'erd']) {
        const out = join(dir, `${name}.svg`);
        const args = ['--in', join(examples, `${name}.d2`), '--out', out, '--label', name];
        expect(run(dir, args).code).toBe(0);
        expect(readFileSync(out, 'utf-8')).toBe(readFileSync(join(examples, `${name}.svg`), 'utf-8'));
      }
    });
  }, 30000);
});
