import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ArchiveError,
  DEFAULT_LIMITS,
  limits,
  normalizeForScreen,
  parseListing,
  screenArchive,
  screenSvg,
} from '../../skills/diagram/scripts/fetch-icons.ts';
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
function writeRegistry(dir: string, over: Record<string, unknown> = {}, pack = 'pack-ok.zip'): string {
  const zip = join(fixtures, pack);
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
  const path = join(dir, `registry-${pack}.json`);
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
    // Fixtures are file:// archives, which production refuses unless asked.
    env: { ...process.env, AGENTKIT_DIAGRAM_ALLOW_LOCAL_PACKS: '1', ...env },
  });
  return { status: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

function runPack(zip: string, over: Record<string, unknown> = {}, env?: Record<string, string>): Run {
  const reg = writeRegistry(dir, over, zip);
  return runFetch(['fixture', '--accept-terms', '--registry', reg, '--root', root], env);
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

  test('a symlinked entry disqualifies the archive before anything is extracted', () => {
    // copyFileSync dereferences, so a symlink named like a kept terms file would
    // copy the target's content into the pack.
    const r = runPack('pack-symlink.zip', { keepFiles: ['Fixture_Terms.txt'] });
    expect(r.status).toBe(1);
    expect(r.out).toContain('non-regular entry');
    expect(r.out).toContain('Fixture_Terms.txt');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('an entry that escapes its root disqualifies the archive', () => {
    const escaped = join(tmpdir(), 'PWNED-SLIP.svg');
    rmSync(escaped, { force: true });
    const r = runPack('pack-traversal.zip');
    expect(r.status).toBe(1);
    expect(r.out).toContain('escapes its root');
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('an archive that unpacks past the size ceiling is refused', () => {
    const r = runPack('pack-oversize.zip');
    expect(r.status).toBe(1);
    expect(r.out).toContain('unpacked archive size');
    expect(r.out).toContain('ceiling');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  // The unit matrix proves the predicate; these prove the whole fetch refuses a
  // real archive carrying each spelling, rather than a string the test composed.
  test.each([
    'single-quote',
    'css-url',
    'uppercase-url',
    'upper-xlink',
    'import-bare',
    'entity',
    'tab-url',
    'xml-base',
  ])('an archive whose icon evades the screen by %s is refused', (kind) => {
    const r = runPack(`evade-${kind}.zip`);
    expect(r.status).toBe(1);
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('an icon carrying several evasions at once is refused on the first', () => {
    const r = runPack('pack-evasion.zip');
    expect(r.status).toBe(1);
    expect(r.out).toContain('Nothing was installed');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('an archive past a lowered entry ceiling fails loud, naming the ceiling', () => {
    // The listing is what the ceiling is read from, so this is the real path:
    // unzip -Z, parse, refuse — not a hand-built entry list.
    const r = runPack('pack-many.zip', {}, { AGENTKIT_DIAGRAM_TEST_LIMITS: 'entries=3' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('over the 3 ceiling');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('a listing too large for its buffer is refused with a reason, not ENOBUFS', () => {
    const r = runPack('pack-many.zip', {}, { AGENTKIT_DIAGRAM_TEST_LIMITS: 'listBytes=200' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('exceeded the 200-byte buffer');
    expect(r.out).not.toContain('ENOBUFS');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('an archive past the download byte budget fails loud, naming the limit', () => {
    const r = runPack('pack-ok.zip', {}, { AGENTKIT_DIAGRAM_TEST_LIMITS: 'archiveBytes=100' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('over the 100-byte ceiling');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('a non-https archive url is refused before any request is made', () => {
    const r = runPack('pack-ok.zip', {
      archives: [{ url: 'http://127.0.0.1:9/plain.zip', sha256: 'b'.repeat(64) }],
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('is not https');
    expect(existsSync(join(root, 'fixture'))).toBe(false);
  });

  test('a file: archive is refused unless local packs are explicitly allowed', () => {
    const r = runPack('pack-ok.zip', {}, { AGENTKIT_DIAGRAM_ALLOW_LOCAL_PACKS: '0' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('is not https');
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

  test.each(['toString', 'constructor', 'valueOf', '__proto__'])(
    'the prototype member %s is not mistaken for a pack',
    (name) => {
      // `in` walks the prototype chain, so these all read as installed packs and
      // a plain typo got reported as a missing pack with an undefined title.
      process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS = registry;
      expect(() => resolveIcon(`${name}:thing`)).toThrow(/unknown icon/);
      expect(() => resolveIcon(`${name}:thing`)).not.toThrow(/is not installed/);
    },
  );

  test('fetching a prototype member names the real packs instead of crashing', () => {
    const r = runFetch(['toString', '--accept-terms', '--registry', registry, '--root', root]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('no vendor pack "toString"');
    expect(r.out).not.toContain('error:');
  });

  test('bundled CC0 icons keep resolving with a vendor registry present', () => {
    process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS = registry;
    expect(resolveIcon('postgres')).toContain('logos/postgresql.svg');
  });
});

describe('what the screens reject', () => {
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">${body}</svg>`;

  // The rule is an allowlist on the target — `#` or `data:`, nothing else — so
  // these are not the cases the screen enumerates, they are the spellings that
  // must all normalize down to the same rejected target.
  test.each([
    ['double-quoted scheme-relative href', '<image href="//evil.example/a.png"/>'],
    ['single-quoted scheme-relative href', "<image href='//evil.example/b.png'/>"],
    ['unquoted href', '<image href=//evil.example/uq.png />'],
    ['scheme-relative css url()', '<style>div{background:url(//evil.example/c.css)}</style>'],
    ['uppercase URL()', '<style>div{background:URL(//evil.example/u.png)}</style>'],
    ['mixed-case Url()', '<style>div{background:Url(//evil.example/m.png)}</style>'],
    ['uppercase XLINK:HREF', '<image XLINK:HREF="//evil.example/x.png"/>'],
    ['@import with a bare string', '<style>@import "https://evil.example/bare.css";</style>'],
    ['@import with url()', '<style>@import url(//evil.example/i.css);</style>'],
    ['entity-encoded slashes', '<image href="&#x2F;&#x2F;evil.example/e.png"/>'],
    // An XML parser decodes element text before CSS ever sees it, so an encoded
    // at-rule is a real at-rule by the time it matters.
    ['an entity-encoded @import', '<style>&#x40;import "https://evil.example/enc.css";</style>'],
    ['a named-entity @import', '<style>&commat;import "https://evil.example/nam.css";</style>'],
    ['decimal-entity slashes', '<image href="&#47;&#47;evil.example/d.png"/>'],
    ['doubly-encoded slashes', '<image href="&amp;#x2F;&amp;#x2F;evil.example/dd.png"/>'],
    ['tab between url and paren', '<style>div{background:url\t(//evil.example/t.png)}</style>'],
    ['newline inside the attribute', '<image href=\n  "//evil.example/n.png"/>'],
    ['whitespace inside url()', '<style>div{background:url( //evil.example/w.png )}</style>'],
    ['an absolute url hidden in xml:base', '<g xml:base="//evil.example/"><use href="#a"/></g>'],
    ['single-quoted absolute href', "<image href='http://evil.example/q.png'/>"],
    // No `//` in any of these, so only the target allowlist stops them: a
    // relative reference still fetches a sibling, and javascript: still runs.
    ['a relative href', '<image href="sibling.svg"/>'],
    ['a relative css url()', '<style>div{background:url(sprite.png)}</style>'],
    ['a javascript: href', '<a href="javascript:alert(1)"><rect/></a>'],
    ['a root-relative href', '<image href="/assets/x.png"/>'],
    ['a script element', '<script>x()</script>'],
    ['an uppercase SCRIPT element', '<SCRIPT>x()</SCRIPT>'],
    ['a foreignObject', '<foreignObject><div/></foreignObject>'],
    ['an inline event handler', '<rect onload="x()"/>'],
    ['an uppercase event handler', '<rect ONLOAD="x()"/>'],
  ])('rejects %s', (_name, body) => {
    const verdict = screenSvg(svg(body));
    expect(verdict.ok).toBe(false);
    expect(verdict.fatal).toBe(true);
  });

  test.each([
    ['a fragment href', '<defs><rect id="r"/></defs><use href="#r"/>'],
    ['a single-quoted fragment href', "<defs><rect id='r'/></defs><use href='#r'/>"],
    ['a fragment css url()', '<rect fill="url(#grad)"/>'],
    ['a data uri', '<image href="data:image/png;base64,AAAA"/>'],
    ['a data uri whose base64 contains slashes', '<image href="data:image/png;base64,iVBOR//w0KGgo="/>'],
    ['the svg and xlink namespace declarations', '<g xmlns:xlink="http://www.w3.org/1999/xlink"><use href="#a"/></g>'],
  ])('keeps %s', (_name, body) => {
    expect(screenSvg(svg(body)).ok).toBe(true);
  });

  test('normalization flattens encoding, case and whitespace to one spelling', () => {
    const text = normalizeForScreen('<A HREF = "&#x2F;&#x2F;x" />\n<style>URL\t( #a )</style>');
    expect(text).toContain('href="//x"');
    expect(text).toContain('url(#a)');
  });

  test('the archive screen refuses too many entries and too many bytes', () => {
    const many = Array.from({ length: 20_001 }, (_, i) => ({ mode: '-rw-r--r--', bytes: 1, name: `i${i}.svg` }));
    expect(() => screenArchive(many, 'u')).toThrow(ArchiveError);
    expect(() => screenArchive(many, 'u')).toThrow(/over the 20000 ceiling/);
    const huge = [{ mode: '-rw-r--r--', bytes: 256 * 1024 * 1024 + 1, name: 'a.svg' }];
    expect(() => screenArchive(huge, 'u')).toThrow(/unpacked archive size/);
  });

  test('the listing parser reads both unix- and DOS-attribute archives', () => {
    // Both real vendor archives are DOS-attribute, where the permission field is
    // 7 characters rather than 10; a parser that reads only one dialect silently
    // screens nothing.
    const raw = [
      'Archive:  x.zip',
      'Zip file size: 1033184 bytes, number of entries: 4',
      '-rw----     2.0 fat   104732 bl defN 26-Jul-08 22:21 Azure_Public_Service_Icons/A.pdf',
      '-rw----     2.0 fat     2769 bl defN 26-Jul-08 22:21 Icons/ai + machine learning/00028-icon.svg',
      'drwxr-xr-x  3.0 unx        0 b- stor 26-Jul-28 16:40 Fixture_Icons/',
      '?rw-------  2.0 unx      135 b- defN 26-Jul-28 17:05 Fixture_Icons/Icons/db/a.svg',
      '4 files, 337 bytes uncompressed, 255 bytes compressed:  24.3%',
    ].join('\n');
    const entries = parseListing(raw);
    expect(entries.map((e) => e.mode[0])).toEqual(['-', '-', 'd', '?']);
    expect(entries[1]!.name).toBe('Icons/ai + machine learning/00028-icon.svg');
    expect(entries[0]!.bytes).toBe(104732);
  });

  test('a listing the parser cannot fully read is refused rather than read as empty', () => {
    const raw = 'Zip file size: 10 bytes, number of entries: 3\ngarbage line\n';
    expect(() => parseListing(raw)).toThrow(/parsed 0 of 3 entries/);
  });

  test('the shipped ceilings are the documented ones', () => {
    // Tests reach the ceilings by lowering them, which would leave a change to
    // the shipped values invisible. This is the assertion that sees it.
    delete process.env.AGENTKIT_DIAGRAM_TEST_LIMITS;
    expect(limits()).toEqual({
      archiveBytes: 64 * 1024 * 1024,
      unpackedBytes: 256 * 1024 * 1024,
      entries: 20_000,
      listBytes: 128 * 1024 * 1024,
    });
  });

  test('the listing buffer stays above what the entry ceiling can print', () => {
    // A listing line is ~60 characters plus the path; if the buffer cannot hold
    // `entries` of them the download dies of ENOBUFS before the ceiling reports.
    expect(DEFAULT_LIMITS.listBytes).toBeGreaterThan(DEFAULT_LIMITS.entries * 300);
  });

  test('the archive screen accepts a real vendor-shaped listing', () => {
    // Positive control: the ceilings must not reject an ordinary archive.
    expect(() => screenArchive([{ mode: '-rw-r--r--', bytes: 4096, name: 'Icons/db/a.svg' }], 'u')).not.toThrow();
    expect(() => screenArchive([{ mode: 'drwxr-xr-x', bytes: 0, name: 'Icons/' }], 'u')).not.toThrow();
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
