import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Byte-parity says the mirror matches its source; it says nothing about whether
// the copy can load where it ships. A cross-skill import copied faithfully into
// a plugin that does not carry the other skill resolves to nothing, and the
// failure lands at module load in a user's install — taking every export down
// with it, not just the lane that changed.
const pluginsRoot = join(import.meta.dir, '..', '..', 'plugins-cc');
const shipped = [...new Glob('*/skills/*/scripts/*.ts').scanSync(pluginsRoot)].sort();

describe('shipped plugin scripts resolve where they ship', () => {
  test('there are shipped scripts to check', () => {
    // A glob that silently matched nothing would make every case below vacuous.
    expect(shipped.length).toBeGreaterThan(0);
  });

  // Resolution, not execution: several of these are CLIs that do their work at
  // module scope, so importing them here would run — or exit — the test process.
  // A build resolves the whole import graph and runs none of it.
  test.each(shipped)('%s resolves its imports', (relative) => {
    const built = spawnSync(
      'bun',
      ['build', '--target=bun', join(pluginsRoot, relative), '--outfile=/dev/null'],
      { encoding: 'utf-8' },
    );
    expect(built.status, `${relative}\n${built.stderr}`).toBe(0);
  });

  // The entry point SKILL.md tells the reader to run, actually loaded: the
  // build above proves the graph resolves, this proves the module evaluates.
  test('the product brief renderer loads from its shipped copy', async () => {
    const scripts = join(pluginsRoot, 'agentkit-product/skills/product-intelligence/scripts');
    expect(typeof (await import(join(scripts, 'render.ts'))).renderDeck).toBe('function');
    const doc = await import(join(scripts, 'doc.ts'));
    expect(typeof doc.renderBrief).toBe('function');
    expect(typeof doc.briefTitle).toBe('function');
  });
});
