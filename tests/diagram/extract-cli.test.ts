import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// dependency-cruiser walks the whole tree; the 5s default is a coin flip
// under full-suite load, and a timeout there reads as a real failure.
const CRUISE_TIMEOUT_MS = 60_000;

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

    // The skill outgrew twelve grouped modules, so the ceiling is lifted here
    // on purpose: this case is about the grouping, and the budget refusal is
    // proven against live data by the next one.
    const result = run(['deps', '--focus', 'skills/diagram', '--group-depth', '2', '--max-nodes', '20'], raw);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    // The extract modules are one component of the diagram skill, reached from
    // its CLI — if that stops being true the grouping has stopped working.
    expect(result.stdout).toContain('scripts_extract: "extract\\n');
    expect(result.stdout).toContain('scripts.scripts_extract_ts -> scripts.scripts_extract:');
  }, CRUISE_TIMEOUT_MS);

  test('the default flags meet both guards on this repository, and narrowing resolves it', () => {
    // Real data either side of the budget: the whole tree is one component over
    // the ceiling at the default depth, and narrowing brings it back. Both
    // remedies the refusal names are exercised — a subtree, then a shallower
    // grouping, which is what the skills subtree needs now that it carries
    // enough modules to exceed the budget at the default depth on its own.
    const cruised = Bun.spawnSync({
      cmd: [depcruise, '--no-config', '--output-type', 'json', 'skills/**/*.ts', 'scripts/**/*.ts', 'plugins/**/*.ts'],
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const raw = cruised.stdout.toString();

    const wide = run(['deps'], raw);
    expect(wide.code).toBe(1);
    expect(wide.stderr).toMatch(/exceeds the density budget.*--focus a subtree/s);

    const subtree = run(['deps', '--focus', 'skills'], raw);
    expect(subtree.code).toBe(1);
    expect(subtree.stderr).toMatch(/exceeds the density budget.*--group-depth/s);

    const focused = run(['deps', '--focus', 'skills', '--group-depth', '1'], raw);
    expect(focused.code).toBe(0);
    expect(focused.stdout).toContain('publish_page: "publish-page');
    // The cross-skill import this repository actually has, derived rather than
    // remembered — skills ship as separate plugins, so it is worth seeing.
    expect(focused.stdout).toMatch(/product_intelligence\S* -> publish_page\S*: "\d+ imports?"/);
  }, CRUISE_TIMEOUT_MS);
});

const hasD2 = Bun.which('d2') !== null;
if (!hasD2) {
  console.error(
    `SKIPPED tests/diagram/extract-cli.test.ts: no d2 on PATH — the derived-topology example `
      + `was NOT re-derived or re-rendered. This skill pins d2 v${D2_PIN}; CI installs it in `
      + `.github/workflows/ci.yml.`,
  );
}

describe.if(hasD2)('hostile source data reaches d2 as text, never as structure', () => {
  // Through the real renderer, not bare d2: it is what expands `icon: @name`,
  // so bare d2 would fail on the icon rather than on the payload under test.
  function compile(dir: string, source: string): { code: number; svg: string; stderr: string } {
    const d2 = join(dir, 'hostile.d2');
    const svg = join(dir, 'hostile.svg');
    writeFileSync(d2, source);
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(repo, 'skills/diagram/scripts/d2-render.ts'), '--in', d2, '--out', svg],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: result.exitCode,
      svg: existsSync(svg) ? readFileSync(svg, 'utf-8') : '',
      stderr: result.stderr.toString(),
    };
  }

  const shapes = (svg: string): number => (svg.match(/class="shape"/g) ?? []).length;
  const connections = (svg: string): number => (svg.match(/class="connection"/g) ?? []).length;

  test('a column type carrying D2 structure declares no node and no edge', () => {
    // The reviewer's replay: before the type was quoted this compiled happily
    // and put a node and an edge into the SVG that exist in no database.
    withTemp((dir) => {
      const payload =
        'TEXT}\nINJECTED: "PWNED" {\n  shape: circle\n}\nINJECTED -> "page": "FAKE EDGE"\nzzz: {\n  shape: sql_table\n  "c": TEXT';
      const schema = {
        driver: { name: 'sqlite' },
        tables: [
          { name: 'page', columns: [{ name: 'id', type: payload }, { name: 'slug', type: 'TEXT' }] },
        ],
      };
      writeFileSync(join(dir, 'in.json'), JSON.stringify(schema));
      const extracted = run(['schema', '--in', join(dir, 'in.json')]);
      expect(extracted.code).toBe(0);

      const out = compile(dir, extracted.stdout);
      expect(out.code).toBe(0);
      // One table, no second node, no edge at all — the payload rendered as
      // the text of a column type, which is exactly what verbatim should mean.
      expect(shapes(out.svg)).toBe(1);
      expect(connections(out.svg)).toBe(0);
      expect(out.svg).toContain('INJECTED');
      expect(out.svg).toContain('slug');
    });
  });

  test('a mount path carrying ${...} renders as typed instead of killing the render', () => {
    // Templated manifests carry these; d2 substitutes inside double quotes, so
    // before the escape this died with `could not resolve variable "ENV"`.
    withTemp((dir) => {
      const manifests = [
        'kind: PersistentVolumeClaim',
        'metadata: { name: data, namespace: app }',
        '---',
        'kind: Deployment',
        'metadata: { name: web, namespace: app }',
        'spec:',
        '  template:',
        '    metadata: { labels: { app: web } }',
        '    spec:',
        '      containers:',
        '        - name: c',
        '          image: nginx:1.27',
        '          volumeMounts: [{ name: v, mountPath: "/data/${ENV}/x" }]',
        '      volumes: [{ name: v, persistentVolumeClaim: { claimName: data } }]',
        '',
      ].join('\n');
      writeFileSync(join(dir, 'in.yaml'), manifests);
      const extracted = run(['k8s', '--in', join(dir, 'in.yaml')]);
      expect(extracted.code).toBe(0);
      expect(extracted.stdout).toContain('\\${ENV}');

      const out = compile(dir, extracted.stdout);
      expect(out.stderr).not.toContain('could not resolve variable');
      expect(out.code).toBe(0);
      expect(out.svg).toContain('/data/${ENV}/x');
    });
  });
});

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
