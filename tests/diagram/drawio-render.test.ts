import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from '../../skills/diagram/scripts/d2-svg.ts';
import { DRAWIO_PIN } from '../../skills/diagram/scripts/drawio-svg.ts';
import {
  binaryCandidates,
  DrawioError,
  needsNoSandbox,
  needsXvfb,
  parseVersion,
  readableStderr,
  resolveLauncher,
  run as launch,
} from '../../skills/diagram/scripts/drawio-binary.ts';

const wrapper = join(import.meta.dir, '../../skills/diagram/scripts/drawio-render.ts');

const DIAGRAM = '<mxfile><diagram name="p" id="p"><mxGraphModel><root>'
  + '<mxCell id="0"/><mxCell id="1" parent="0"/>'
  + '<mxCell id="a" value="api" style="rounded=0;html=0;fontSize=14;" vertex="1" parent="1">'
  + '<mxGeometry x="20" y="20" width="120" height="50" as="geometry"/></mxCell>'
  + '</root></mxGraphModel></diagram></mxfile>';

interface Run {
  code: number;
  stderr: string;
}

function run(dir: string, args: string[], env: Record<string, string> = {}): Run {
  const result = Bun.spawnSync({
    cmd: [process.execPath, wrapper, ...args],
    cwd: dir,
    // DISPLAY keeps the xvfb branch out of the way; these cases never launch a
    // browser, and a machine without xvfb-run would otherwise fail first.
    env: { ...process.env, DISPLAY: ':0', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

// A stub keeps the pin check honest on a machine that has the real binary.
function stubDrawio(dir: string, version: string): string {
  const bin = join(dir, 'stub');
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, 'drawio');
  writeFileSync(exe, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}" && exit 0\nexit 1\n`);
  chmodSync(exe, 0o755);
  return exe;
}

// Signal 0 tests for existence without delivering anything; a killed process is
// reaped by this process only if it was our child, so ESRCH is the real answer.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withTempAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'drawio-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'drawio-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('binary discovery', () => {
  test('an explicit override is preferred over every install location', () => {
    expect(binaryCandidates({ AGENTKIT_DRAWIO: '/x/drawio' } as NodeJS.ProcessEnv, '/home/u')[0])
      .toBe('/x/drawio');
  });

  test('the agentkit-local extraction is searched before any system package', () => {
    const found = binaryCandidates({} as NodeJS.ProcessEnv, '/home/u');
    expect(found[0]).toBe('/home/u/.agentkit/diagram/drawio/squashfs-root/drawio');
    expect(found).toContain('/usr/bin/drawio');
  });

  test('the version line is read past the Chromium noise Electron writes first', () => {
    expect(parseVersion(`[123:ERROR:dbus/bus.cc:405] Failed\n${DRAWIO_PIN}\n`)).toBe(DRAWIO_PIN);
    expect(parseVersion(`v${DRAWIO_PIN}`)).toBe(DRAWIO_PIN);
    expect(parseVersion('nothing here')).toBe('');
  });
});

describe('headless preconditions', () => {
  test('Linux with no display needs xvfb, and a session with one does not', () => {
    expect(needsXvfb({} as NodeJS.ProcessEnv, 'linux')).toBe(true);
    expect(needsXvfb({ DISPLAY: ':0' } as NodeJS.ProcessEnv, 'linux')).toBe(false);
    expect(needsXvfb({ WAYLAND_DISPLAY: 'wayland-0' } as NodeJS.ProcessEnv, 'linux')).toBe(false);
    expect(needsXvfb({} as NodeJS.ProcessEnv, 'darwin')).toBe(false);
  });

  test('an unprivileged chrome-sandbox next to the binary forces --no-sandbox', () => {
    withTemp((dir) => {
      const exe = join(dir, 'drawio');
      writeFileSync(exe, '');
      expect(needsNoSandbox(exe)).toBe(false);
      // The AppImage extraction ships it 0755 and owned by the extracting user;
      // Electron then aborts rather than run with a sandbox it cannot trust.
      writeFileSync(join(dir, 'chrome-sandbox'), '');
      expect(needsNoSandbox(exe)).toBe(true);
      expect(resolveLauncher({ AGENTKIT_DRAWIO: exe, DISPLAY: ':0' }, dir, 'linux').sandbox)
        .toEqual(['--no-sandbox']);
    });
  });

  test('a machine with no draw.io is told so, not left with a spawn error', () => {
    withTemp((dir) => {
      expect(() => resolveLauncher({ AGENTKIT_DRAWIO: join(dir, 'nope') }, dir, 'darwin'))
        .toThrow('no draw.io Desktop binary found');
    });
  });
});

describe('a failed launch is reported in full', () => {
  test('Chromium noise is dropped when there is a real message under it', () => {
    const text = '[1:ERROR:dbus/bus.cc:405] Failed\nno such file: a.drawio\n[2] zygote died';
    expect(readableStderr(text)).toBe('no such file: a.drawio');
  });

  test('noise is kept when it is the only account of the failure there is', () => {
    // Filtering to nothing left the operator with "draw.io failed:" and a blank
    // line, which says less than the noise would have.
    const onlyNoise = '[1:ERROR:ui/ozone:257] Missing X server or $DISPLAY';
    expect(readableStderr(onlyNoise)).toBe(onlyNoise);
    expect(readableStderr('   ')).toBe('');
  });
});

describe('a hung render takes its whole process group with it', () => {
  test('the browser xvfb-run wrapped is killed too, not just the wrapper', async () => {
    // xvfb-run is a shell script: signalling it alone leaves the browser running
    // with its X server pulled away. Both survived that on this host.
    await withTempAsync(async (dir) => {
      const marker = join(dir, 'child.pid');
      const exe = join(dir, 'drawio');
      writeFileSync(exe, `#!/bin/sh\nsleep 120 &\necho $! > ${marker}\nsleep 120\n`);
      chmodSync(exe, 0o755);

      const started = Date.now();
      const failure = await launch({ binary: exe, sandbox: [] }, [], 1500)
        .then(() => null, (e: unknown) => e as Error);
      expect(failure).toBeInstanceOf(DrawioError);
      expect(failure?.message).toContain('process group was killed');
      expect(Date.now() - started).toBeLessThan(30_000);

      const grandchild = Number(readFileSync(marker, 'utf-8').trim());
      expect(Number.isFinite(grandchild)).toBe(true);
      expect(alive(grandchild)).toBe(false);
    });
  }, 60_000);
});

describe('the wrapper refuses a source it cannot ship', () => {
  test('a compressed diagram is refused, because its styles cannot be screened', () => {
    withTemp((dir) => {
      const file = join(dir, 'a.drawio');
      writeFileSync(file, '<mxfile><diagram id="a" name="p">7Vpbc9o4FP41zLQPZHzh0sfc</diagram></mxfile>');
      const result = run(dir, ['--in', file]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('compressed');
      expect(result.stderr).toContain('Edit Diagram');
    });
  });

  test('html=1 is refused before a binary is even looked for, naming the cell', () => {
    withTemp((dir) => {
      const file = join(dir, 'a.drawio');
      writeFileSync(file, DIAGRAM.replace('html=0', 'html=1'));
      // HOME is redirected so the local extraction cannot satisfy discovery:
      // the screening must fail on a machine with no draw.io at all.
      const result = run(dir, ['--in', file], { HOME: dir, AGENTKIT_DRAWIO: '/nonexistent' });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('foreignObject');
      expect(result.stderr).toContain('a: html=1 → html=0');
      expect(result.stderr).toContain('containment gate');
    });
  });

  test('a mismatched draw.io is refused, naming the pin', () => {
    withTemp((dir) => {
      const file = join(dir, 'a.drawio');
      writeFileSync(file, DIAGRAM);
      const result = run(dir, ['--in', file], { AGENTKIT_DRAWIO: stubDrawio(dir, '30.0.1') });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('30.0.1');
      expect(result.stderr).toContain(`pins v${DRAWIO_PIN}`);
    });
  });

  test('a missing --in is named rather than crashing', () => {
    withTemp((dir) => {
      expect(run(dir, []).stderr).toContain('--in <file.drawio> is required');
    });
  });
});

// Bun.spawnSync throws ENOENT for a missing executable rather than reporting a
// non-zero exit, which would crash this file instead of skipping it.
const installed = binaryCandidates(process.env, homedir()).find((c) => existsSync(c));
if (!installed) {
  console.error(
    `SKIPPED the render case in tests/diagram/drawio-render.test.ts: no draw.io Desktop `
      + `found — this skill pins v${DRAWIO_PIN}; see skills/diagram/references/`
      + `stencil-register.md for the headless install recipe.`,
  );
}

describe.if(Boolean(installed))('rendering', () => {
  test('produces a self-contained SVG with no foreignObject', () => {
    withTemp((dir) => {
      const file = join(dir, 'a.drawio');
      writeFileSync(file, DIAGRAM);
      const out = join(dir, 'a.svg');
      // An empty DISPLAY, not the stub ':0' the refusal cases use: this case
      // launches a real browser and must take the xvfb branch on a headless box.
      const result = run(dir, ['--in', file, '--out', out, '--label', 'A caption'], {
        DISPLAY: '',
      });
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
      const svg = readFileSync(out, 'utf-8');
      const found = inspect(svg);
      expect({ fo: found.foreignObjects, urls: found.externalUrls, refs: found.imageRefs })
        .toEqual({ fo: 0, urls: [], refs: 0 });
      expect(svg).toContain('aria-label="A caption"');
      expect(svg).toContain('<text');
    });
  });

  test('the committed example is exactly what the renderer produces from its source', () => {
    withTemp((dir) => {
      const out = join(dir, 'cloud-topology.svg');
      const result = run(dir, [
        '--in',
        join(import.meta.dir, '../../skills/diagram/examples/cloud-topology.drawio'),
        '--out',
        out,
        '--label',
        'Cloud topology — ALB to EKS to RDS',
      ], { DISPLAY: '' });
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
      // Byte-equal, not merely equivalent: draw.io salts its gradient ids per
      // render, and a figure that churns on every re-render cannot be reviewed.
      expect(readFileSync(out, 'utf-8')).toBe(
        readFileSync(join(import.meta.dir, '../../skills/diagram/examples/cloud-topology.svg'), 'utf-8'),
      );
    });
  }, 120_000);
});
