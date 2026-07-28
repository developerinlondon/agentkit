import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetsDir, expandIconRefs, IconError, manifest, resolveIcon } from '../../skills/diagram/scripts/icons.ts';

const selection = JSON.parse(readFileSync(join(assetsDir, 'icon-selection.json'), 'utf-8'));

describe('vendored icon assets', () => {
  test('every manifest entry resolves to a file that exists', () => {
    for (const key of Object.keys(manifest())) expect(() => resolveIcon(key)).not.toThrow();
  });

  test('a manifest entry pointing at a deleted asset is refused, naming the file', () => {
    // The check above is satisfied by a manifest with no guard at all; this one
    // fails unless resolveIcon actually stats the file it hands back.
    const dir = mkdtempSync(join(tmpdir(), 'icons-test-'));
    try {
      const record = { set: 'logos', name: 'ghost', file: 'logos/ghost.svg', license: 'CC0-1.0' };
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ghost: record }));
      expect(() => resolveIcon('ghost', dir)).toThrow(IconError);
      expect(() => resolveIcon('ghost', dir)).toThrow(/maps to missing file logos\/ghost\.svg/);
      expect(() => expandIconRefs('a: X {\n  icon: @ghost\n}\n', dir)).toThrow(IconError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every vendored set carries its own NOTICE and is CC0', () => {
    for (const prefix of Object.keys(selection.packs)) {
      const notice = readFileSync(join(assetsDir, prefix, 'NOTICE'), 'utf-8');
      expect(notice).toContain('CC0-1.0');
      expect(notice).toContain('trademarks of their respective owners');
    }
    expect(readFileSync(join(assetsDir, 'LICENSE.CC0-1.0.txt'), 'utf-8')).toContain('CC0 1.0 Universal');
  });

  test('every vendored file is a self-contained svg with a viewBox', () => {
    for (const prefix of Object.keys(selection.packs)) {
      for (const file of readdirSync(join(assetsDir, prefix)).filter((f) => f.endsWith('.svg'))) {
        const svg = readFileSync(join(assetsDir, prefix, file), 'utf-8');
        expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="');
        expect(svg).not.toContain('<script');
        expect(svg).not.toContain('http://www.w3.org/1999/xhtml');
      }
    }
  });

  test('no monochrome glyph ships an unresolved currentColor', () => {
    // currentColor inside a d2 <image> resolves to black against its own
    // document, not the diagram — the icon would vanish on a dark island.
    for (const prefix of Object.keys(selection.packs)) {
      for (const file of readdirSync(join(assetsDir, prefix)).filter((f) => f.endsWith('.svg'))) {
        expect(readFileSync(join(assetsDir, prefix, file), 'utf-8')).not.toContain('currentColor');
      }
    }
  });
});

describe('icon reference expansion', () => {
  test('a set-qualified reference expands to a staged relative path, never an absolute one', () => {
    // An absolute path in the expanded source would salt d2's element ids with
    // the checkout location, so the same diagram would render differently on
    // every machine. The icon is staged beside the source instead.
    const { source, count, staged } = expandIconRefs('a: X {\n  icon: @logos:postgresql\n}\n');
    expect(count).toBe(1);
    expect(source).toContain('icon: icons/logos/postgresql.svg');
    expect(source).not.toContain('@logos');
    expect(source).not.toContain(assetsDir);
    expect(staged).toEqual([
      { rel: 'icons/logos/postgresql.svg', src: join(assetsDir, 'logos/postgresql.svg') },
    ]);
  });

  test('a keyword alias expands to the icon it names', () => {
    const { source } = expandIconRefs('a: X {\n  icon: @postgres\n}\n');
    expect(source).toContain('logos/postgresql.svg');
  });

  test('an alias containing spaces is resolved', () => {
    const { source } = expandIconRefs('a: X {\n  icon: @object storage\n}\n');
    expect(source).toContain('logos/aws-s3.svg');
  });

  test('several references in one document are all expanded', () => {
    const { count } = expandIconRefs('a: {\n  icon: @redis\n}\nb: {\n  icon: @logos:kafka\n}\n');
    expect(count).toBe(2);
  });

  test('an already-expanded path is left alone', () => {
    const src = 'a: X {\n  icon: ./local.svg\n}\n';
    expect(expandIconRefs(src)).toEqual({ source: src, count: 0, staged: [] });
  });

  test('a bare name present in both sets resolves to the full-colour one', () => {
    // "argo" ships in both; the flat simple-icons glyph stays reachable only
    // when asked for by set, so a bare reference never loses brand colour.
    expect(resolveIcon('argo')).toContain('logos/argo.svg');
    expect(resolveIcon('simple-icons:argo')).toContain('simple-icons/argo.svg');
  });

  test('an unknown icon fails loudly rather than rendering a gap', () => {
    expect(() => expandIconRefs('a: {\n  icon: @not-a-real-icon\n}\n')).toThrow(IconError);
  });

  test('a misspelling suggests the vendored name', () => {
    expect(() => resolveIcon('postgresq')).toThrow(/did you mean.*postgresql/);
  });
});
