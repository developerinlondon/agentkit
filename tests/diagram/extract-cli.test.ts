import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D2_PIN } from '../../skills/diagram/scripts/d2-svg.ts';

const repo = join(import.meta.dir, '../..');
const cli = join(repo, 'skills/diagram/scripts/extract.ts');
const fixtures = join(import.meta.dir, 'fixtures');
const examples = join(repo, 'skills/diagram/examples');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin?: string): Run {
  const result = Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    cwd: repo,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'extract-cli-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the extract CLI', () => {
  test('every extractor named in the usage text is actually dispatched', () => {
    const usage = run(['--in', 'x']).stderr;
    for (const kind of ['deps', 'schema', 'infra', 'k8s']) {
      expect(usage).toContain(kind);
      const result = run([kind, '--in', join(fixtures, 'k8s-publishing.yaml'), '--max-nodes', '20']);
      // Wrong input for three of the four, but each must reach its own parser
      // rather than fall through to a dispatcher error.
      expect(result.stderr).not.toContain('unknown extractor');
    }
  });

  test('an unknown extractor prints the usage rather than a bare failure', () => {
    const result = run(['erd', '--in', 'x']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown extractor "erd"');
    expect(result.stderr).toContain('usage:');
  });

  test('input arrives on stdin as readily as from a file', () => {
    const raw = readFileSync(join(fixtures, 'tbls-publishing.json'), 'utf-8');
    const piped = run(['schema'], raw);
    const filed = run(['schema', '--in', join(fixtures, 'tbls-publishing.json')]);
    expect(piped.code).toBe(0);
    expect(piped.stdout).toBe(filed.stdout);
  });

  test('--out writes the file and keeps stdout clean', () => {
    withTemp((dir) => {
      const out = join(dir, 'a.d2');
      const result = run(['schema', '--in', join(fixtures, 'tbls-publishing.json'), '--out', out]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(readFileSync(out, 'utf-8')).toContain('shape: sql_table');
    });
  });

  test('a missing input file is named, not swallowed', () => {
    const result = run(['schema', '--in', '/nonexistent/schema.json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot read /nonexistent/schema.json');
  });

  test('a flag given without its value is refused before anything is read', () => {
    const result = run(['deps', '--in', '--focus', 'src']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--in is missing its value');
  });

  test('a non-numeric budget is refused rather than silently defaulted', () => {
    for (const bad of ['zero', '0', '-4', '2.5']) {
      const result = run(['schema', '--in', join(fixtures, 'tbls-publishing.json'), '--max-nodes', bad]);
      expect(result.stderr).toContain('--max-nodes must be a positive integer');
    }
  });

  test('an unsupported direction is refused with the ones that work', () => {
    const result = run(['k8s', '--in', join(fixtures, 'k8s-publishing.yaml'), '--direction', 'sideways']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--direction must be one of down, right, up, left');
  });

  test('--direction reaches the emitted source', () => {
    const args = ['k8s', '--in', join(fixtures, 'k8s-publishing.yaml'), '--max-nodes', '20'];
    expect(run(args).stdout).toContain('direction: down');
    expect(run([...args, '--direction', 'right']).stdout).toContain('direction: right');
  });

  test('a refusal is a message and an exit code, never a stack trace', () => {
    const result = run(['deps', '--in', join(fixtures, 'tbls-publishing.json')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('extract: ');
    expect(result.stderr).not.toContain('at <anonymous>');
  });

  test('the same input yields the same output twice', () => {
    const args = ['infra', '--in', join(fixtures, 'tofu-state.json')];
    expect(run(args).stdout).toBe(run(args).stdout);
  });

  test('output carries no filesystem path, so a render cannot depend on the checkout', () => {
    // d2 salts element ids from the source text it compiles; an absolute path
    // in the provenance line would make committed renders unreproducible.
    for (const kind of [['schema', 'tbls-publishing.json'], ['infra', 'tofu-state.json']]) {
      const out = run([kind[0] as string, '--in', join(fixtures, kind[1] as string)]).stdout;
      expect(out).not.toContain(repo);
      expect(out.split('\n')[0]).not.toContain('/');
    }
  });
});

const depcruise = join(repo, 'node_modules/.bin/depcruise');
const hasDepcruise = existsSync(depcruise);
if (!hasDepcruise) {
  console.error(
    'SKIPPED tests/diagram/extract-cli.test.ts: no node_modules/.bin/depcruise — the live '
      + 'self-test against this repository did NOT run. Run `bun install`; CI installs it from '
      + 'the lockfile.',
  );
}
if (!hasDepcruise && process.env.CI !== undefined) {
  throw new Error('dependency-cruiser is a pinned devDependency and must be installed in CI');
}

describe.if(hasDepcruise)('a live cruise of this repository', () => {
  test('agentkit\'s own module graph comes out as a figure, not a hairball', () => {
    const cruised = Bun.spawnSync({
      cmd: [depcruise, '--no-config', '--output-type', 'json', 'skills/**/*.ts', 'scripts/**/*.ts'],
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(cruised.exitCode).toBe(0);
    const raw = cruised.stdout.toString();
    expect(JSON.parse(raw).summary.totalCruised).toBeGreaterThan(20);

    const result = run(['deps', '--focus', 'skills/diagram', '--group-depth', '2'], raw);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    // The extract modules are one component of the diagram skill, reached from
    // its CLI — if that stops being true the grouping has stopped working.
    expect(result.stdout).toContain('scripts_extract: "extract\\n');
    expect(result.stdout).toContain('scripts.scripts_extract_ts -> scripts.scripts_extract:');
  });

  test('the whole repository at one node per top directory stays inside the budget', () => {
    const cruised = Bun.spawnSync({
      cmd: [depcruise, '--no-config', '--output-type', 'json', 'skills/**/*.ts', 'scripts/**/*.ts', 'plugins/**/*.ts'],
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const result = run(['deps'], cruised.stdout.toString());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('skills: "skills\\n');
  });
});

const hasD2 = Bun.which('d2') !== null;
if (!hasD2) {
  console.error(
    `SKIPPED tests/diagram/extract-cli.test.ts: no d2 on PATH — the derived-topology example `
      + `was NOT re-derived or re-rendered. This skill pins d2 v${D2_PIN}; CI installs it in `
      + `.github/workflows/ci.yml.`,
  );
}

describe('the committed derived example', () => {
  const source = join(examples, 'derived-topology.d2');

  test('its D2 is exactly what the extractor produces from the committed manifests', () => {
    const result = run(['k8s', '--in', join(fixtures, 'k8s-publishing.yaml'), '--max-nodes', '20']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(readFileSync(source, 'utf-8'));
  });

  test.if(hasD2)('its SVG is exactly what the renderer produces from that D2', () => {
    withTemp((dir) => {
      const out = join(dir, 'derived-topology.svg');
      const render = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(repo, 'skills/diagram/scripts/d2-render.ts'),
          '--in',
          source,
          '--out',
          out,
          '--label',
          'Publishing namespace, derived from its manifests',
        ],
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(render.exitCode).toBe(0);
      expect(readFileSync(out, 'utf-8')).toBe(readFileSync(join(examples, 'derived-topology.svg'), 'utf-8'));
    });
  });

  test.if(hasD2)('the derived source compiles with the icons it references embedded', () => {
    const svg = readFileSync(join(examples, 'derived-topology.svg'), 'utf-8');
    expect(svg).toContain('svg-source:d2');
    expect(svg).toContain('href="data:image/svg+xml;base64,');
    expect(svg).not.toContain('assets/iconify');
    expect(svg.match(/https?:\/\/(?!www\.w3\.org)/)).toBeNull();
  });
});
