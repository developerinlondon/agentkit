import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const diagramDir = join(repoRoot, 'skills', 'diagram');

// renderer/** is excluded in tsconfig.json — it needs @excalidraw/excalidraw
// installed, which the diagram skill's 271 MB dependency tree is
// deliberately not part of a root install. Everything else, scripts/layout/
// included, is checked.
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
