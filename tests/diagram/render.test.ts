import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D2_PIN } from '../../skills/diagram/scripts/d2-svg.ts';

const wrapper = join(import.meta.dir, '../../skills/diagram/scripts/d2-render.ts');
const SOURCE = 'a: API {\n  icon: @postgres\n}\nb: Worker\na -> b: enqueue\n';

interface Run {
  code: number;
  stderr: string;
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
      const src = join(dir, 'a.d2');
      writeFileSync(src, SOURCE);
      const out = join(dir, 'a.svg');
      expect(run(dir, ['--in', src, '--out', out]).code).toBe(0);
      const svg = readFileSync(out, 'utf-8');
      expect(svg).toContain('href="data:image/svg+xml;base64,');
      expect(svg).not.toContain('assets/iconify');
      expect(svg).not.toContain('.svg"');
    });
  });

  test('output is self-contained, house-attributed and theme-switchable', () => {
    withTemp((dir) => {
      const src = join(dir, 'a.d2');
      writeFileSync(src, SOURCE);
      const out = join(dir, 'a.svg');
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

  test('an unknown icon fails the render instead of dropping the glyph', () => {
    withTemp((dir) => {
      const src = join(dir, 'a.d2');
      writeFileSync(src, 'a: X {\n  icon: @no-such-icon\n}\n');
      const result = run(dir, ['--in', src, '--out', join(dir, 'a.svg')]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('unknown icon');
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
