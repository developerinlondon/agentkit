import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const postinstall: string = root.scripts?.postinstall ?? '';

// A skill that carries its own package.json is a second install nobody performs.
// `skills/publish-page` is imported at MODULE LOAD by three suites, so without it
// the import throws and fifteen assertions fail pointing at the renderer — a
// clean clone reads as a code regression. The root postinstall closes that.
function nestedPackages(): string[] {
  const skills = join(repo, 'skills');
  return readdirSync(skills)
    .filter((name) => existsSync(join(skills, name, 'package.json')))
    .sort();
}

describe('nested skill packages are installed by a root install', () => {
  test('the set of nested packages is what we decided about', () => {
    // A new one appearing must force a decision rather than silently inheriting
    // whichever default the last person happened to pick.
    expect(nestedPackages()).toEqual(['diagram', 'publish-page']);
  });

  test('publish-page is installed, because the suite cannot load without it', () => {
    expect(postinstall).toContain('--cwd skills/publish-page');
  });

  test('the nested install is pinned to its lockfile', () => {
    // An unpinned nested install rewrites a committed lockfile during CI and
    // leaves the tree dirty for whatever checks the working copy next.
    expect(postinstall).toContain('--frozen-lockfile');
  });

  test('diagram is deliberately excluded', () => {
    // Measured rather than assumed: with skills/diagram/node_modules absent,
    // tests/diagram is 270 pass / 0 fail. Its dependencies are excalidraw,
    // react, react-dom and playwright-core, so installing them on every root
    // install would cost every contributor for a suite that does not need them.
    expect(postinstall).not.toContain('--cwd skills/diagram');
    const diagram = JSON.parse(readFileSync(join(repo, 'skills/diagram/package.json'), 'utf8'));
    expect(Object.keys(diagram.dependencies ?? {})).toContain('@excalidraw/excalidraw');
  });

  test('every nested package the postinstall names actually exists', () => {
    const named = [...postinstall.matchAll(/--cwd\s+(\S+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const dir of named) {
      expect({ dir, present: existsSync(join(repo, dir, 'package.json')) })
        .toEqual({ dir, present: true });
    }
  });
});
