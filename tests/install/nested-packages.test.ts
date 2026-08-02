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
  // Asserting only the script's text passes while the effect is absent: refactor
  // the postinstall behind a helper and the string tests break with behaviour
  // intact, and `bun install --ignore-scripts` skips it entirely while they stay
  // green. This asserts the outcome, so both cases fail here rather than as
  // fifteen assertions blaming the renderer.
  test('publish-page is actually resolvable, not merely named in a script', () => {
    const marked = join(repo, 'skills/publish-page/node_modules/marked');
    expect({
      resolvable: existsSync(marked),
      remedy: 'bun install (or, if you passed --ignore-scripts: bun install --cwd skills/publish-page)',
    }).toEqual({
      resolvable: true,
      remedy: 'bun install (or, if you passed --ignore-scripts: bun install --cwd skills/publish-page)',
    });
  });

  test('the set of nested packages is what we decided about', () => {
    const decided = ['diagram', 'publish-page'];
    // A new one appearing must force a decision rather than silently inheriting
    // whichever default the last person happened to pick. The remedy rides in
    // the assertion, not a comment, so the next person does not just delete it.
    expect({
      packages: nestedPackages(),
      then: 'decide whether a root install should carry it, then update this test',
    }).toEqual({
      packages: decided,
      then: 'decide whether a root install should carry it, then update this test',
    });
  });

  test('publish-page is installed, because the suite cannot load without it', () => {
    expect(postinstall).toContain('--cwd skills/publish-page');
  });

  test('the nested install is pinned, and says what to do when the lockfile drifts', () => {
    // Pinned for CI parity and drift detection — not to keep the tree clean; an
    // unpinned install of an in-sync lockfile leaves it clean either way. Drift
    // fails the WHOLE root install, and bun's own advice is to re-run without
    // --frozen-lockfile, which fails identically because the flag lives in the
    // script. So the script prints the remedy that actually works.
    expect(postinstall).toContain('--frozen-lockfile');
    expect(postinstall).toContain('bun install --cwd skills/publish-page, then commit that lockfile');
  });

  test('diagram is deliberately excluded', () => {
    // Measured rather than assumed: with skills/diagram/node_modules absent,
    // tests/diagram is 283 pass / 0 fail. Its dependencies are excalidraw,
    // react, react-dom and playwright-core, so installing them on every root
    // install would cost every contributor for a suite that does not need them.
    expect(postinstall).not.toContain('--cwd skills/diagram');
    const diagram = JSON.parse(readFileSync(join(repo, 'skills/diagram/package.json'), 'utf8'));
    expect(Object.keys(diagram.dependencies ?? {})).toContain('@excalidraw/excalidraw');
  });

  test('every nested package the postinstall names actually exists', () => {
    // Only the command, not the failure message — which quotes a --cwd of its
    // own and whose trailing punctuation is not part of a path.
    const command = postinstall.split('||')[0];
    const named = [...command.matchAll(/--cwd\s+(\S+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const dir of named) {
      expect({ dir, present: existsSync(join(repo, dir, 'package.json')) })
        .toEqual({ dir, present: true });
    }
  });
});
