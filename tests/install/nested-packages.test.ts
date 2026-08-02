import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const postinstall: string = root.scripts?.postinstall ?? '';
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const NESTED_SCRIPT = 'scripts/install-nested.sh';
const script = existsSync(join(repo, NESTED_SCRIPT)) ? read(NESTED_SCRIPT) : '';
// Commands only: the failure message quotes a --cwd of its own, and the command
// itself may be wrapped (`if bun install ...; then`).
const installCommands = script.split('\n')
  .filter((l) => l.includes('bun install') && !l.trim().startsWith('echo'));

// A skill that carries its own package.json is a second install nobody performs.
// `skills/publish-page` is imported at MODULE LOAD by three suites, so without it
// the import throws and the assertions blame the renderer — a clean clone reads
// as a code regression. The root postinstall closes that.
function nestedPackages(): string[] {
  const skills = join(repo, 'skills');
  return readdirSync(skills)
    .filter((name) => existsSync(join(skills, name, 'package.json')))
    .sort();
}

const RELATIVE_IMPORT = /(?:from|import|require)\s*[(\s]\s*['"](\.[^'"]+)['"]/g;

function reachable(entries: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = normalize(stack.pop() as string);
    if (seen.has(file) || !existsSync(join(repo, file))) continue;
    seen.add(file);
    for (const m of read(file).matchAll(RELATIVE_IMPORT)) {
      // Bun resolves './x' to x.ts and './dir' to dir/index.ts; push every
      // candidate, since an extensionless import must not evade the walk.
      const target = relative(repo, join(repo, dirname(file), m[1]));
      stack.push(target, `${target}.ts`, `${target}/index.ts`);
    }
  }
  return [...seen].sort();
}

function diagramModulesTestsLoad(): string[] {
  const dir = join(repo, 'tests/diagram');
  const found = new Set<string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    for (const m of read(join('tests/diagram', name)).matchAll(/['"][^'"]*?(skills\/diagram\/[\w/.-]+\.ts)['"]/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe('nested skill packages are installed by a root install', () => {
  // Asserting only the script's text passes while the effect is absent: refactor
  // the postinstall behind a helper and the string tests break with behaviour
  // intact, and `bun install --ignore-scripts` skips it entirely while they stay
  // green. This asserts the outcome, so an --ignore-scripts tree fails here with
  // a remedy — in addition to, not instead of, the assertions that blame the
  // renderer.
  test('publish-page is actually resolvable, not merely named in a script', () => {
    const remedy = 'bun install (with --ignore-scripts: bun install --cwd skills/publish-page)';
    expect({ resolvable: existsSync(join(repo, 'skills/publish-page/node_modules/marked')), remedy })
      .toEqual({ resolvable: true, remedy });
  });

  test('the set of nested packages under skills/ is what we decided about', () => {
    // plugins-cc carries generated copies; sync-cc-plugin.sh owns those, so only
    // the sources are governed here. A new source package must force a decision
    // rather than inherit whichever default the last person happened to pick,
    // and the remedy rides in the assertion so it is read at the point of failure.
    const then = 'decide whether a root install should carry it, then update this test';
    expect({ packages: nestedPackages(), then })
      .toEqual({ packages: ['diagram', 'publish-page'], then });
  });

  test('the postinstall runs the nested install, and it is a real file', () => {
    expect(postinstall).toContain(NESTED_SCRIPT);
    expect(existsSync(join(repo, NESTED_SCRIPT))).toBe(true);
  });

  test('publish-page is installed, because the suite cannot load without it', () => {
    expect(installCommands.join('\n')).toContain('--cwd skills/publish-page');
  });

  test('the nested install is pinned, and says what to do when the lockfile drifts', () => {
    // Pinned for CI parity and drift detection, not for a clean tree: an
    // unpinned install of an in-sync lockfile leaves it clean too. Drift fails
    // the WHOLE root install, and bun's own advice is to re-run without
    // --frozen-lockfile, which fails identically because the flag lives in this
    // script — so it prints the remedy that works.
    expect(installCommands.join('\n')).toContain('--frozen-lockfile');
    expect(script).toContain('bun install --cwd skills/publish-page, then commit it');
    // Naming drift as THE cause was wrong for every other failure — a wrong
    // directory, an unwritable one, bun absent from PATH — and this assertion
    // pinned the wrong sentence in place.
    expect(script).not.toContain('bun.lock is out of date');
  });

  test('a pinned nested install only means anything where a lockfile exists', () => {
    // skills/diagram has none, so --frozen-lockfile there succeeds while pinning
    // nothing. Whoever adds it to the postinstall must commit a lockfile first,
    // or inherit the false assurance rather than the guarantee.
    for (const pkg of nestedPackages()) {
      const named = installCommands.some((l) => l.includes(`--cwd skills/${pkg}`));
      const locked = existsSync(join(repo, 'skills', pkg, 'bun.lock'));
      expect({ pkg, namedWithoutLockfile: named && !locked }).toEqual({ pkg, namedWithoutLockfile: false });
    }
  });

  test('excluding diagram is safe: nothing the tests load reaches its runtime deps', () => {
    // The exclusion holds only while no module tests import pulls excalidraw,
    // react or playwright at load time. Nothing enforced that, which is this
    // file's own defect one package over. Today renderer/entry.ts is the sole
    // importer and no test path reaches it.
    const entries = diagramModulesTestsLoad();
    expect(entries.length).toBeGreaterThan(0);
    const deps = Object.keys({
      ...JSON.parse(read('skills/diagram/package.json')).dependencies,
      ...JSON.parse(read('skills/diagram/package.json')).devDependencies,
    }).filter((d) => !d.startsWith('@types/'));
    const alt = deps.map((d) => d.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
    const pattern = new RegExp(`(?:from|import|require)\\s*[(\\s]\\s*['"](?:${alt})(?:/[^'"]*)?['"]`);
    const offenders = reachable(entries).filter((f) => pattern.test(read(f)));
    expect({ offenders, then: 'either install diagram in the postinstall, or move that import' })
      .toEqual({ offenders: [], then: 'either install diagram in the postinstall, or move that import' });
  });

  test('every nested package the postinstall names actually exists', () => {
    const named = [...installCommands.join('\n').matchAll(/--cwd\s+([\w./-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const dir of named) {
      expect({ dir, present: existsSync(join(repo, dir, 'package.json')) })
        .toEqual({ dir, present: true });
    }
  });
});
