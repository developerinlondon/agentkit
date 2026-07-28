import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateFile } from '../../skills/product-intelligence/scripts/validate.ts';
import { canonicalTarget, checkOrigins, deriveOrigins } from '../../skills/product-intelligence/scripts/origins.ts';
import { renderOrientation } from '../../skills/product-intelligence/scripts/orient.ts';

const repoRoot = dirname(dirname(import.meta.dir));
const skillRoot = join(repoRoot, 'skills', 'product-intelligence');
const scripts = join(skillRoot, 'scripts');
const example = join(skillRoot, 'examples', 'composition');
const declaration = join(example, 'product.yaml');

const parse = (path: string) => Bun.YAML.parse(readFileSync(path, 'utf-8')) as Record<string, any>;

function tempDeclaration(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentkit-composition-'));
  const path = join(dir, 'product.yaml');
  writeFileSync(path, body);
  return path;
}

// YAML is a superset of JSON, so the parser reads this back unchanged.
function tempBrief(origins: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentkit-composition-'));
  const path = join(dir, 'brief.yaml');
  writeFileSync(path, JSON.stringify({ subject: { origins } }));
  return path;
}

describe('derived origins', () => {
  test('every part becomes one origin, keyed by the part id', () => {
    const origins = deriveOrigins(parse(declaration));
    expect(origins.map((o) => o.id)).toEqual(['engine', 'console', 'cloud']);
    expect(origins.map((o) => o.target)).toEqual([
      'acme/engine',
      'acme/console',
      'https://app.acme.example',
    ]);
  });

  // A brief has no origin kind for something that runs; a service is evidence
  // you acquire by visiting its URL, which is the site lane.
  test('a service part derives a site origin, repo and site pass through', () => {
    expect(deriveOrigins(parse(declaration)).map((o) => o.kind)).toEqual(['repo', 'repo', 'site']);
  });

  test("the example brief's origins are exactly what the declaration derives", () => {
    const check = checkOrigins(deriveOrigins(parse(declaration)), parse(join(example, 'brief.yaml')));
    expect(check.errors).toEqual([]);
    expect(check.notes).toEqual([]);
  });

  test('a part with no origin in the brief is an error', () => {
    const brief = parse(join(example, 'brief.yaml'));
    brief.subject.origins = brief.subject.origins.filter((o: { id: string }) => o.id !== 'console');
    expect(checkOrigins(deriveOrigins(parse(declaration)), brief).errors.join('\n')).toContain(
      "missing origin for part 'console'",
    );
  });

  // The skill tells you to cite the product repo's own documents, which are not
  // a part; failing on that would make the documented workflow permanently red.
  test('an origin that is not a declared part is a note, not a failure', () => {
    const brief = parse(join(example, 'brief.yaml'));
    brief.subject.origins.push({ id: 'product', kind: 'repo', target: 'acme/product' });
    const check = checkOrigins(deriveOrigins(parse(declaration)), brief);
    expect(check.errors).toEqual([]);
    expect(check.notes.join('\n')).toContain("origin 'product' is not a declared part");
  });

  test('a retargeted part is drift, and says what each side claims', () => {
    const brief = parse(join(example, 'brief.yaml'));
    brief.subject.origins[0].target = 'acme/engine-fork';
    const check = checkOrigins(deriveOrigins(parse(declaration)), brief);
    expect(check.errors).toHaveLength(1);
    expect(check.errors[0]).toContain("origin 'engine' cites repo acme/engine-fork");
    expect(check.errors[0]).toContain('the part declares repo acme/engine');
    expect(check.notes).toEqual([]);
  });
});

describe('target notation', () => {
  const briefCiting = (target: string) => {
    const brief = parse(join(example, 'brief.yaml'));
    brief.subject.origins[0].target = target;
    return brief;
  };
  const errorsFor = (target: string) =>
    checkOrigins(deriveOrigins(parse(declaration)), briefCiting(target)).errors;

  // Both schemas advertise these as the same repository, so a comparator that
  // disagreed would report one repo as missing and unrecognised at once.
  for (
    const notation of [
      'https://github.com/acme/engine',
      'http://github.com/acme/engine',
      'https://github.com/acme/engine.git',
      'https://github.com/acme/engine/',
      'git@github.com:acme/engine.git',
      'https://GITHUB.com/acme/engine',
    ]
  ) {
    test(`the declaration's 'acme/engine' matches a brief citing '${notation}'`, () => {
      expect(errorsFor(notation)).toEqual([]);
    });
  }

  test('the same equivalence holds when the declaration carries the URL form', () => {
    const path = tempDeclaration(
      'product_version: "0.1"\nproduct:\n  name: acme\ncomposition:\n  parts:\n    - id: engine\n'
        + '      kind: repo\n      target: https://github.com/acme/engine.git\n',
    );
    const brief = { subject: { origins: [{ id: 'engine', kind: 'repo', target: 'acme/engine' }] } };
    expect(checkOrigins(deriveOrigins(parse(path)), brief).errors).toEqual([]);
  });

  // Normalising must not go so far that two repos become one.
  test('the same owner/repo on two hosts stays two repositories', () => {
    const path = tempDeclaration(
      'product_version: "0.1"\nproduct:\n  name: acme\ncomposition:\n  parts:\n    - id: engine\n'
        + '      kind: repo\n      target: https://github.com/acme/engine\n',
    );
    const brief = {
      subject: { origins: [{ id: 'engine', kind: 'repo', target: 'https://gitlab.com/acme/engine' }] },
    };
    expect(checkOrigins(deriveOrigins(parse(path)), brief).errors.join('\n')).toContain('gitlab.com');
  });

  test('a different repo under the same host is still drift', () => {
    expect(errorsFor('https://github.com/acme/engine-fork').join('\n')).toContain('engine-fork');
  });

  // Only exercises host folding when BOTH sides state a host: with one side
  // bare, the comparison short-circuits and any casing would pass.
  test('two spellings of one host are the same host', () => {
    const path = tempDeclaration(
      'product_version: "0.1"\nproduct:\n  name: acme\ncomposition:\n  parts:\n    - id: engine\n'
        + '      kind: repo\n      target: https://GitHub.COM/acme/engine\n',
    );
    const brief = { subject: { origins: [{ id: 'engine', kind: 'repo', target: 'https://github.com/acme/engine' }] } };
    expect(checkOrigins(deriveOrigins(parse(path)), brief).errors).toEqual([]);
  });

  test('a matching target under the wrong kind is drift', () => {
    const brief = parse(join(example, 'brief.yaml'));
    brief.subject.origins[0].kind = 'site';
    const errors = checkOrigins(deriveOrigins(parse(declaration)), brief).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cites site acme/engine');
  });

  // filter(Boolean) hides a trailing slash on any hosted target, so the strip
  // is only load-bearing where there is no host to split on.
  test('a trailing slash is not part of a bare target', () => {
    expect(canonicalTarget('docset', 'contracts/')).toEqual(canonicalTarget('docset', 'contracts'));
  });

  test('a service URL matches with or without scheme and trailing slash', () => {
    const brief = parse(join(example, 'brief.yaml'));
    brief.subject.origins[2].target = 'app.acme.example/';
    expect(checkOrigins(deriveOrigins(parse(declaration)), brief).errors).toEqual([]);
  });

  test('a differing URL path is not folded away', () => {
    const brief = parse(join(example, 'brief.yaml'));
    brief.subject.origins[2].target = 'https://app.acme.example/status';
    expect(checkOrigins(deriveOrigins(parse(declaration)), brief).errors).toHaveLength(1);
  });
});

describe('workspace orientation', () => {
  test('names the product, every part, and where each one lives', () => {
    const page = renderOrientation(declaration);
    expect(page).toContain('acme-platform — workspace orientation');
    for (const part of ['engine', 'console', 'cloud']) expect(page, part).toContain(`\`${part}\``);
    expect(page).toContain('acme/engine');
    expect(page).toContain('https://app.acme.example');
  });

  test('points at the evidence and the published page', () => {
    const page = renderOrientation(declaration);
    expect(page).toContain('`brief.yaml`');
    expect(page).toContain('`ledger.yaml`');
    expect(page).toContain('https://pages.acme.example/acme-platform');
  });

  // An unescaped pipe silently shifts every column after it, so the table would
  // still render — wrongly — and nobody would notice.
  test('a pipe in a declared field cannot split a table cell', () => {
    const path = tempDeclaration(
      'product_version: "0.1"\nproduct:\n  name: acme\ncomposition:\n  parts:\n    - id: engine\n'
        + '      kind: repo\n      target: acme/engine\n      role: "core | api"\n',
    );
    const row = renderOrientation(path).split('\n').find((line) => line.includes('`engine`')) as string;
    expect(row.split(/(?<!\\)\|/)).toHaveLength(7);
    expect(row).toContain('core \\| api');
  });

  // A literal block, not a folded one: YAML folds `>-` into a single line by
  // itself, so a folded fixture would pass without collapse() doing anything.
  test('a multi-line description collapses instead of breaking the list', () => {
    const path = tempDeclaration(
      'product_version: "0.1"\nproduct:\n  name: acme\ncomposition:\n  parts:\n    - id: engine\n'
        + '      kind: repo\n      target: acme/engine\n      description: |-\n        first line\n        second line\n',
    );
    const page = renderOrientation(path);
    expect(page).toContain('- **engine** — first line second line');
    expect(page.split('\n').filter((l) => l.includes('second line'))).toHaveLength(1);
  });

  // The generator cannot see whether components carry markers — this branch is
  // what makes them possible — so the page states the convention rather than
  // reporting unverified state as fact.
  test('states the part_of convention without claiming components already follow it', () => {
    const page = renderOrientation(declaration);
    expect(page).toContain('convention is that a component names the part it is');
    expect(page).not.toContain('must agree on the id');
  });

  test('refuses to render an invalid declaration rather than orienting from a guess', () => {
    const path = tempDeclaration('product_version: "0.1"\nproduct:\n  name: acme\n');
    expect(() => renderOrientation(path)).toThrow(/composition/);
  });

  // The checked-in example is documentation only while it matches its own
  // generator; a stale one teaches a shape the tool no longer produces.
  test('the committed example is what the generator produces today', () => {
    expect(readFileSync(join(example, 'ORIENTATION.md'), 'utf-8')).toBe(renderOrientation(declaration));
  });
});

describe('component part-of marker', () => {
  test('the example component manifest carries a valid marker beside its surfaces', () => {
    const path = join(example, 'component-product.yaml');
    expect(validateFile(path)).toEqual([]);
    const manifest = parse(path);
    expect(manifest.part_of.part).toBe('engine');
    expect(manifest.surfaces).toBeDefined();
  });

  // The marker is only worth carrying if it resolves: its part id must name a
  // part the product declaration actually lists.
  test('the marker names a part the declaration declares', () => {
    const marker = parse(join(example, 'component-product.yaml')).part_of;
    expect(deriveOrigins(parse(declaration)).map((o) => o.id)).toContain(marker.part);
  });
});

describe('composition CLIs', () => {
  const run = (script: string, ...args: string[]) =>
    spawnSync('bun', [join(scripts, script), ...args], { encoding: 'utf-8' });

  test('origins.ts prints a pasteable subject.origins block', () => {
    const result = run('origins.ts', declaration);
    expect(result.status, result.stderr).toBe(0);
    expect(Bun.YAML.parse(result.stdout)).toEqual({
      subject: { origins: deriveOrigins(parse(declaration)) },
    });
  });

  test('origins.ts --json emits the same origins as data', () => {
    const result = run('origins.ts', declaration, '--json');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(deriveOrigins(parse(declaration)));
  });

  test('origins.ts --check exits 0 when the brief matches', () => {
    const result = run('origins.ts', declaration, '--check', join(example, 'brief.yaml'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('cites every part declared by');
  });

  test('origins.ts --check accepts a brief citing a source that is not a part', () => {
    const brief = tempBrief([
      ...deriveOrigins(parse(declaration)),
      { id: 'product', kind: 'repo', target: 'acme/product' },
    ]);
    const result = run('origins.ts', declaration, '--check', brief);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("note: ");
    expect(result.stdout).toContain("origin 'product' is not a declared part");
  });

  test('origins.ts --check points at the remedy when a part is uncited', () => {
    const result = run('origins.ts', declaration, '--check', tempBrief([]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hint:');
    expect(result.stderr).toContain('origins the declaration derives');
  });

  test('origins.ts --check exits 1 and names the drift', () => {
    const result = run('origins.ts', declaration, '--check', join(example, '..', 'mixed', 'brief.yaml'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing origin for part 'engine'");
  });

  test('origins.ts refuses an invalid declaration instead of deriving from it', () => {
    const path = tempDeclaration('product_version: "0.1"\nproduct:\n  name: acme\n');
    const result = run('origins.ts', path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required field 'composition'");
  });

  test('origins.ts exits 2 with usage on a bad invocation', () => {
    expect(run('origins.ts').status).toBe(2);
    expect(run('origins.ts', declaration, '--check').status).toBe(2);
    expect(run('origins.ts', declaration, '--nope').stderr).toContain('usage');
  });

  test('orient.ts writes ORIENTATION.md beside the declaration and prints the path', () => {
    const path = tempDeclaration(readFileSync(declaration, 'utf-8'));
    const out = join(dirname(path), 'ORIENTATION.md');
    // The copy has no evidence files beside it, so only the parts survive.
    const result = run('orient.ts', path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not found relative to the declaration');
    expect(run('orient.ts', declaration, '--out', out).status, out).toBe(0);
    expect(readFileSync(out, 'utf-8')).toBe(renderOrientation(declaration));
  });

  test('orient.ts exits 2 with usage on a bad invocation', () => {
    expect(run('orient.ts').status).toBe(2);
    expect(run('orient.ts', declaration, '--out').stderr).toContain('usage');
  });
});
