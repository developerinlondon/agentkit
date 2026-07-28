import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expandIconRefs, IconError, resolveIcon } from '../../skills/diagram/scripts/icons.ts';
import { packs, registryPath } from '../../skills/diagram/scripts/vendor-packs.ts';

const repoRoot = join(import.meta.dir, '..', '..');
const fetchScript = join(repoRoot, 'skills/diagram/scripts/fetch-icons.ts');
const fixtures = join(repoRoot, 'tests/fixtures/vendor-packs');

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// The fixture registry is written per-test because a file:// URL is absolute and
// therefore cannot be committed. Everything else mirrors a real pack entry.
function writeRegistry(dir: string, over: Record<string, unknown> = {}): string {
  const zip = join(fixtures, 'pack-ok.zip');
  const registry = {
    fixture: {
      title: 'Fixture icon pack',
      vendor: 'Fixture Corp',
      license: 'Fixture proprietary licence',
      landingUrl: 'https://fixture.example/icons',
      termsUrl: 'https://fixture.example/terms',
      grant: 'express',
      terms: ['Fixture Corp permits use of these icons in diagrams only.'],
      archives: [{ url: pathToFileURL(zip).href, sha256: sha256Of(zip), bytes: 2347 }],
      nameStrip: ['^\\d+-icon-service-'],
      categorySkip: ['Fixture_Icons', 'Icons'],
      keepFiles: ['Fixture_Terms.txt'],
      ...over,
    },
  };
  const path = join(dir, 'registry.json');
  writeFileSync(path, JSON.stringify(registry, null, 2));
  return path;
}

interface Run {
  status: number;
  out: string;
}

function runFetch(args: string[], env: Record<string, string> = {}): Run {
  const r = Bun.spawnSync(['bun', fetchScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  return { status: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

let dir: string;
let registry: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vendor-icons-test-'));
  registry = writeRegistry(dir);
  root = join(dir, 'root');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS;
  delete process.env.AGENTKIT_DIAGRAM_VENDOR_ICONS;
});

function fetchOk(extra: string[] = []): Run {
  const r = runFetch(['fixture', '--accept-terms', '--registry', registry, '--root', root, ...extra]);
  expect(r.status).toBe(0);
  return r;
}

describe('fetching a vendor pack', () => {
  test('verifies, unpacks and registers icons under the pack root', () => {
    const r = fetchOk();
    expect(r.out).toContain('fixture: 3 icons');
    const manifest = JSON.parse(readFileSync(join(root, 'fixture/manifest.json'), 'utf-8'));
    expect(Object.keys(manifest)).toContain('widget-store');
    expect(existsSync(join(root, 'fixture/databases/widget-store.svg'))).toBe(true);
    expect(readFileSync(join(root, 'fixture/databases/widget-store.svg'), 'utf-8')).toContain('#0078d4');
  });

  test('the same artwork filed under two categories is stored once', () => {
    fetchOk();
    // Identical copies under databases/ and "new icons/" must collapse even
    // though a different widget-store under compute/ sorts ahead of both and
    // takes the bare name: dedup is per artwork, not per bare name.
    expect(existsSync(join(root, 'fixture/databases/widget-store.svg'))).toBe(true);
    expect(existsSync(join(root, 'fixture/new-icons/widget-store.svg'))).toBe(false);
  });

  test('two different icons sharing a name stay reachable, and the clash is reported', () => {
    const r = fetchOk();
    expect(r.out).toContain('widget-store');
    expect(r.out).toContain('exist more than once with different artwork');
    // Bare name goes to the first in path order; the loser stays addressable.
    expect(readFileSync(resolveIconIn('fixture:widget-store'), 'utf-8')).toContain('#107c10');
    expect(readFileSync(resolveIconIn('fixture:databases/widget-store'), 'utf-8')).toContain('#0078d4');
  });

  test('an icon d2 cannot scale is skipped by name rather than silently dropped', () => {
    const r = fetchOk();
    expect(r.out).toContain('skipped 1 unusable file');
    expect(r.out).toContain('No-Box');
    expect(r.out).toContain('no viewBox');
  });

  test('an icon referencing its own document by fragment is kept', () => {
    // Regression: the first screen rejected every href, which threw out 11 real
    // Azure icons whose only href was a `<use href="#id">` into themselves.
    fetchOk();
    expect(existsSync(join(root, 'fixture/compute/fragment-ref.svg'))).toBe(true);
  });

  test("the vendor's own terms file is carried into the fetched tree", () => {
    fetchOk();
    expect(readFileSync(join(root, 'fixture/Fixture_Terms.txt'), 'utf-8')).toContain('fixture terms');
  });

  test('the NOTICE records the terms verbatim, the source and the trademark rule', () => {
    fetchOk();
    const notice = readFileSync(join(root, 'fixture/NOTICE'), 'utf-8');
    expect(notice).toContain('Fixture Corp permits use of these icons in diagrams only.');
    expect(notice).toContain('https://fixture.example/terms');
    expect(notice).toContain('must not be redistributed');
    expect(notice).toContain('never be recoloured');
  });

  test('a pack with no vendor grant says so in its NOTICE', () => {
    const ungranted = writeRegistry(dir, { grant: 'absent' });
    expect(runFetch(['fixture', '--accept-terms', '--registry', ungranted, '--root', root]).status).toBe(0);
    expect(readFileSync(join(root, 'fixture/NOTICE'), 'utf-8')).toContain('NO LICENCE IS GRANTED');
  });

  test('a second run is a no-op until --force', () => {
    fetchOk();
    expect(fetchOk().out).toContain('already installed');
    expect(fetchOk(['--force']).out).toContain('fixture: 3 icons');
  });
});

describe('what fetching refuses', () => {
  test('an archive whose bytes changed is rejected, naming the hash to re-pin', () => {
    const stale = writeRegistry(dir, { archives: [{ url: pathToFileURL(join(fixtures, 'pack-ok.zip')).href, sha256: 'f'.repeat(64) }] });
    const r = runFetch(['fixture', '--accept-terms', '--registry', stale, '--root', root]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('checksum mismatch');
    expect(r.out).toContain(sha256Of(join(fixtures, 'pack-ok.zip')));
    expect(r.out).toContain('vendor-packs.json');
    // A rejected archive must leave nothing behind, or the next render resolves
    // icons the checksum never vouched for.
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('a stale pin does not overwrite an already-installed pack', () => {
    fetchOk();
    const stale = writeRegistry(dir, { archives: [{ url: pathToFileURL(join(fixtures, 'pack-ok.zip')).href, sha256: 'a'.repeat(64) }] });
    expect(runFetch(['fixture', '--accept-terms', '--registry', stale, '--root', root]).status).toBe(1);
    expect(existsSync(join(root, 'fixture/databases/widget-store.svg'))).toBe(true);
  });

  test('an icon carrying script disqualifies the whole pack', () => {
    const zip = join(fixtures, 'pack-hostile.zip');
    const hostile = writeRegistry(dir, { archives: [{ url: pathToFileURL(zip).href, sha256: sha256Of(zip) }] });
    const r = runFetch(['fixture', '--accept-terms', '--registry', hostile, '--root', root]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('<script>');
    expect(r.out).toContain('Nothing was installed');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('nothing is fetched until the terms are accepted', () => {
    const r = runFetch(['fixture', '--registry', registry, '--root', root]);
    expect(r.status).toBe(2);
    expect(r.out).toContain('Fixture Corp permits use of these icons in diagrams only.');
    expect(r.out).toContain('--accept-terms');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('an unknown pack name lists the packs that do exist', () => {
    const r = runFetch(['nosuchpack', '--registry', registry, '--root', root]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('no vendor pack "nosuchpack"');
    expect(r.out).toContain('fixture');
  });
});

function resolveIconIn(key: string): string {
  process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS = registry;
  process.env.AGENTKIT_DIAGRAM_VENDOR_ICONS = root;
  return resolveIcon(key);
}

describe('resolving a vendor icon', () => {
  test('a fetched icon resolves and stages exactly like a bundled one', () => {
    fetchOk();
    process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS = registry;
    process.env.AGENTKIT_DIAGRAM_VENDOR_ICONS = root;
    const { source, count, staged } = expandIconRefs('a: X {\n  icon: @fixture:widget-store\n}\n');
    expect(count).toBe(1);
    expect(source).toContain('icon: icons/fixture/compute/widget-store.svg');
    expect(source).not.toContain(root);
    expect(staged).toEqual([
      { rel: 'icons/fixture/compute/widget-store.svg', src: join(root, 'fixture/compute/widget-store.svg') },
    ]);
  });

  test('the pack separator may be a slash as well as a colon', () => {
    fetchOk();
    expect(resolveIconIn('fixture/widget-store')).toBe(resolveIconIn('fixture:widget-store'));
  });

  test('an unfetched pack names the command that fetches it', () => {
    process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS = registry;
    process.env.AGENTKIT_DIAGRAM_VENDOR_ICONS = root;
    expect(() => resolveIcon('fixture:widget-store')).toThrow(IconError);
    expect(() => resolveIcon('fixture:widget-store')).toThrow(/is not installed/);
    expect(() => resolveIcon('fixture:widget-store')).toThrow(/fetch-icons\.ts fixture --accept-terms/);
  });

  test('a wrong name inside a fetched pack is not reported as a missing pack', () => {
    fetchOk();
    expect(() => resolveIconIn('fixture:widget-stor')).toThrow(/has no icon "widget-stor"/);
    expect(() => resolveIconIn('fixture:widget-stor')).toThrow(/did you mean.*widget-store/);
  });

  test('a bare name that is not a pack prefix still reports an unknown icon', () => {
    process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS = registry;
    expect(() => resolveIcon('nosuchset:thing')).toThrow(/unknown icon/);
  });

  test('bundled CC0 icons keep resolving with a vendor registry present', () => {
    process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS = registry;
    expect(resolveIcon('postgres')).toContain('logos/postgresql.svg');
  });
});

describe('the committed registry', () => {
  const registered = packs(join(repoRoot, 'skills/diagram/assets/vendor-packs.json'));

  test('every pack pins each archive to a full sha256 over https', () => {
    for (const [id, info] of Object.entries(registered)) {
      expect(info.archives.length, id).toBeGreaterThan(0);
      for (const a of info.archives) {
        expect(a.url, id).toStartWith('https://');
        expect(a.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  test('every pack records its terms verbatim and where they live', () => {
    for (const [id, info] of Object.entries(registered)) {
      expect(info.terms.length, id).toBeGreaterThan(0);
      expect(info.termsUrl, id).toStartWith('https://');
      expect(['express', 'absent'], id).toContain(info.grant);
      // A vendor pack claiming a free-content licence would mean it belonged in
      // the committed CC0 tree instead, and the fetch path is the wrong home.
      expect(info.license, id).not.toContain('CC0');
    }
  });

  test('the licence reference quotes every pack term verbatim', () => {
    const doc = readFileSync(join(repoRoot, 'skills/diagram/references/VENDOR-LICENSES.md'), 'utf-8');
    for (const [id, info] of Object.entries(registered)) {
      expect(doc, id).toContain(info.termsUrl);
      for (const term of info.terms) expect(doc, id).toContain(term.replaceAll('\n', ' '));
    }
  });

  test('the default install root is outside the repository', () => {
    delete process.env.AGENTKIT_DIAGRAM_VENDOR_ICONS;
    const { vendorRoot } = require('../../skills/diagram/scripts/vendor-packs.ts');
    expect(vendorRoot().startsWith(repoRoot)).toBe(false);
  });

  test('no vendor artwork is committed', () => {
    // The repository may carry URLs, hashes and terms — never the icons.
    const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: repoRoot }).stdout.toString().split('\n');
    for (const pack of Object.keys(registered)) {
      expect(tracked.filter((f) => f.includes(`vendor-icons/${pack}/`))).toEqual([]);
    }
  });

  test('registryPath honours the override used to test without a network', () => {
    process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS = registry;
    expect(registryPath()).toBe(registry);
  });
});
