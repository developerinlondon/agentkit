import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSources } from '../../skills/taste/scripts/sources.ts';
import { MEMORY, TASTE } from '../../skills/taste/scripts/store.ts';
import { type SyncResult, syncSources } from '../../skills/taste/scripts/sync.ts';
import type { Target } from '../../skills/taste/scripts/visibility.ts';
import {
  type Remote,
  remote,
  removeScratch,
  scratch,
  source,
  sourcesConfig,
  taste,
} from '../taste/fixtures.ts';

afterEach(removeScratch);

const TODAY = '2026-08-06';
const USER_CONFIG = '.config/agentkit/config.yaml';
const PUBLIC = { ref: 'v1', name: 'knowledge', visibility: 'public' };

function memoryConfig(...sources: string[]): string {
  return sourcesConfig('memory', ...sources);
}

function note(name: string): string {
  return `# ${name}\n\nWhat is true about ${name}, as of the commit this was pinned at.\n`;
}

function knowledgebase(files?: Record<string, string>): Remote {
  const built = remote(files ?? {
    'decisions/postgres.md': note('postgres'),
    'runbook.md': note('runbook'),
  });
  built.tag('v1');
  return built;
}

function target(visibility: Target['visibility'], detail = 'the fixture said so') {
  return async (): Promise<Target> => ({ visibility, detail });
}

// One declaring repository, one empty machine: the shape every case below
// varies by its source fields and whatever else is already in the checkout.
function declaring(
  upstream: Remote,
  fields: Record<string, string> = PUBLIC,
  files: Record<string, string> = {},
): { cwd: string; home: string } {
  return {
    cwd: scratch({
      '.agentkit/config.yaml': memoryConfig(source(upstream.url, fields)),
      ...files,
    }),
    home: scratch({}),
  };
}

async function sync(
  where: { cwd: string; home: string },
  probe = target('private'),
): Promise<SyncResult> {
  return await syncSources({ store: MEMORY, ...where, env: {}, today: TODAY, probe });
}

function vendored(root: string, name = 'knowledge'): string {
  return join(root, 'memory', 'external', name);
}

describe('a knowledgebase is declared under brain.memory.sources', () => {
  test('memory reads its own list, and does not read taste\'s', () => {
    const cwd = scratch({
      '.agentkit/config.yaml': `brain:\n  taste:\n    sources:\n${
        source('git@github.com:owner/tastes.git', { ref: 'v1', visibility: 'public' })
      }\n  memory:\n    sources:\n${
        source('git@github.com:owner/knowledgebase.git', { ref: 'v1', visibility: 'public' })
      }\n`,
    });
    const home = scratch({});

    expect(readSources(MEMORY, cwd, home, {}).sources.map((entry) => entry.name))
      .toEqual(['knowledgebase']);
    expect(readSources(TASTE, cwd, home, {}).sources.map((entry) => entry.name))
      .toEqual(['tastes']);
  });

  test('a refusal names brain.memory.sources, not the key taste reads', () => {
    const cwd = scratch({
      '.agentkit/config.yaml': memoryConfig(source('git@github.com:owner/kb.git', {})),
    });
    const { errors } = readSources(MEMORY, cwd, scratch({}), {});

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('brain.memory.sources[0]');
    expect(errors[0]).toContain('missing ref');
  });
});

describe('a memory source vendors into the vault the hooks already read', () => {
  test('the repository vault takes the snapshot and the lock sits beside it', async () => {
    const upstream = knowledgebase();
    const where = declaring(upstream);
    const result = await sync(where);

    expect(result.errors).toEqual([]);
    expect(readFileSync(join(vendored(where.cwd), 'runbook.md'), 'utf-8')).toContain('# runbook');
    expect(readFileSync(join(vendored(where.cwd), 'decisions', 'postgres.md'), 'utf-8'))
      .toContain('# postgres');

    const lock = readFileSync(join(where.cwd, '.agentkit', 'memory.lock'), 'utf-8');
    expect(lock).toContain('brain.memory.sources');
    expect(lock).toContain('.agentkit/memory.lock');
    expect(lock).toContain(upstream.head());
  });

  test('the machine vault takes a machine-declared source, and the checkout takes none', async () => {
    const upstream = knowledgebase();
    const where = {
      cwd: scratch({}),
      home: scratch({
        [USER_CONFIG]: memoryConfig(source(upstream.url, { ref: 'v1', name: 'knowledge' })),
      }),
    };
    const result = await sync(where);

    expect(result.errors).toEqual([]);
    expect(
      existsSync(join(where.home, '.agentkit', 'memory', 'external', 'knowledge', 'runbook.md')),
    ).toBe(true);
    expect(existsSync(join(where.home, '.agentkit', 'memory.lock'))).toBe(true);
    expect(existsSync(join(where.cwd, 'memory'))).toBe(false);
  });

  test('the count a sync reports is notes, and nothing but markdown lands', async () => {
    const where = declaring(knowledgebase({
      'runbook.md': note('runbook'),
      'restore.sh': '#!/usr/bin/env bash\nrm -rf /\n',
    }));
    const result = await sync(where);

    expect(result.errors).toEqual([]);
    expect(result.report.some((line) => line.includes('1 note'))).toBe(true);
    expect(existsSync(join(vendored(where.cwd), 'runbook.md'))).toBe(true);
    expect(existsSync(join(vendored(where.cwd), 'restore.sh'))).toBe(false);
  });

  test('a source with no notes is refused rather than vendored empty', async () => {
    const where = declaring(knowledgebase({ 'README.txt': 'not markdown\n' }));
    const result = await sync(where);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('no notes at v1');
    expect(existsSync(vendored(where.cwd))).toBe(false);
  });

  // The snapshot is re-taken from the pinned ref on every sync, which is what
  // makes a vendored source read-only: anything written into it is destroyed.
  test('a directory no longer declared is removed from the vault', async () => {
    const where = declaring(knowledgebase(), PUBLIC, {
      'memory/external/retired/old.md': note('old'),
    });
    const result = await sync(where);

    expect(result.errors).toEqual([]);
    expect(existsSync(join(where.cwd, 'memory', 'external', 'retired'))).toBe(false);
    expect(result.report.some((line) => line.includes('memory/external/retired'))).toBe(true);
  });

  test('a memory sync leaves the taste tree alone', async () => {
    const where = declaring(knowledgebase(), PUBLIC, {
      '.agentkit/tastes/release-tier.md': taste('release-tier'),
    });
    await sync(where);

    expect(existsSync(join(where.cwd, '.agentkit', 'tastes', 'external'))).toBe(false);
    expect(existsSync(join(where.cwd, '.agentkit', 'tastes.lock'))).toBe(false);
    expect(existsSync(join(where.cwd, '.agentkit', 'tastes', 'release-tier.md'))).toBe(true);
  });
});

// The guard is the reason memory reuses this resolver rather than growing its
// own: a private knowledgebase vendored into a public repository is the same
// leak whether the files are conventions or notes.
describe('the visibility guard covers a memory source as it covers a taste source', () => {
  test('a private source is refused into a public repository', async () => {
    const where = declaring(knowledgebase(), { ...PUBLIC, visibility: 'private' });
    const result = await sync(where, target('public', 'gh reports it is public'));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('refusing to vendor a private source');
    expect(existsSync(vendored(where.cwd))).toBe(false);
  });

  test('a repository source that declares no visibility is refused, naming notes', async () => {
    const where = declaring(knowledgebase(), { ref: 'v1', name: 'knowledge' });
    const result = await sync(where);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('visibility is not declared');
    expect(result.errors.join('\n')).toContain('notes');
    expect(existsSync(vendored(where.cwd))).toBe(false);
  });

  test('a public source is vendored into a public repository', async () => {
    const where = declaring(knowledgebase());
    const result = await sync(where, target('public'));

    expect(result.errors).toEqual([]);
    expect(existsSync(join(vendored(where.cwd), 'runbook.md'))).toBe(true);
  });
});
