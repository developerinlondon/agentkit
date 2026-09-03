import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const diagramDir = join(repoRoot, 'skills', 'diagram');

// scripts/layout/** and renderer/** are excluded in tsconfig.json — the
// former has a pre-existing dagre typing gap, the latter needs
// @excalidraw/excalidraw installed, which the diagram skill's 271 MB
// dependency tree is deliberately not part of a root install.
describe('skills/diagram typechecks clean', () => {
  test('tsc --noEmit -p skills/diagram reports no errors', () => {
    const result = Bun.spawnSync({
      cmd: ['bunx', 'tsc', '--noEmit', '-p', diagramDir],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({
      code: result.exitCode,
      output: (result.stdout.toString() + result.stderr.toString()).trim(),
    }).toEqual({ code: 0, output: '' });
  }, 30_000);
});
