import { describe, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from './probe';

// The wrapper was a local function that shadowed bun's test() for the whole
// file, so every case got diagnostics by lexical scope. Splitting turned it
// into an import, and an import is easy to lose: an editor auto-importing
// test() from bun:test next to describe/expect leaves a file whose failures
// explain nothing, and the suite stays green either way.
const ALLOWED_FROM_BUN_TEST = ['describe', 'expect'];

function siblingTestFiles(): string[] {
  return readdirSync(import.meta.dir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
}

function importedNames(source: string, module: string): string[] {
  const escaped = module.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}'`, 'g');
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    for (const clause of match[1].split(',')) {
      const imported = clause.trim().split(/\s+as\s+/)[0]?.trim();
      if (imported) names.push(imported);
    }
  }
  return names;
}

function hasNamespaceImport(source: string, module: string): boolean {
  const escaped = module.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s*'${escaped}'`).test(source);
}

describe('review-police: every test file uses the diagnostics wrapper', () => {
  const files = siblingTestFiles();

  test('the sibling scan is not silently empty', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('wrapper-coverage.test.ts');
  });

  for (const name of files) {
    const source = readFileSync(join(import.meta.dir, name), 'utf-8');

    test(`${name} takes only describe and expect from bun:test`, () => {
      const disallowed = importedNames(source, 'bun:test')
        .filter((imported) => !ALLOWED_FROM_BUN_TEST.includes(imported));
      expect(disallowed, name).toEqual([]);
      // A namespace import reaches bun's test() without ever naming it.
      expect(hasNamespaceImport(source, 'bun:test'), name).toBe(false);
    });

    test(`${name} takes test() from the diagnostics wrapper`, () => {
      expect(importedNames(source, './probe'), name).toContain('test');
    });
  }
});
