import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { lintTastePath } from '../../skills/taste/scripts/lint.ts';
import { resolveTastes } from '../../skills/taste/scripts/resolve.ts';
import { syncSources } from '../../skills/taste/scripts/sync.ts';
import { remote, removeScratch, scratch, taste, treeOf } from './fixtures.ts';

afterEach(removeScratch);

const GENERIC = 'git@github.com:developerinlondon/agentkit-tastes.git';
const CENTRAL = 'git@github.com:developerinlondon/business-tastes.git';

function source(repo: string, extra: Record<string, string> = {}): string {
  const lines = [`    - repo: ${repo}`];
  for (const [key, value] of Object.entries(extra)) lines.push(`      ${key}: ${value}`);
  return lines.join('\n');
}

function config(...sources: string[]): string {
  return `taste:\n  sources:\n${sources.join('\n')}\n`;
}

const ONE = config(source(GENERIC, { ref: 'v2026.08.1' }));
const BOTH = config(
  source(GENERIC, { ref: 'v2026.08.1' }),
  source(CENTRAL, { ref: 'v2026.08.4' }),
);

function where(files: Record<string, string>, homeFiles: Record<string, string> = {}) {
  return { cwd: scratch(files), home: scratch(homeFiles) };
}

function project(name: string, body?: string): string {
  return taste(name, { scope: 'project' }, body);
}

// One tree with two origins. The layer a file lands in is decided by where it
// sits under `.agentkit/tastes/`, and `external/` is the only part of it a sync
// writes — so a snapshot counted as a project taste would give a source the
// precedence the repository's own files are supposed to hold over it.
describe('external sources are a subtree of the tastes folder', () => {
  test('a taste under external/ resolves as external, naming its source', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': ONE,
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste('release-tier'),
    });
    const { tastes } = resolveTastes(cwd, home, {});

    expect(tastes.map((entry) => entry.name)).toEqual(['release-tier']);
    expect(tastes[0]?.layer).toBe('external');
    expect(tastes[0]?.source).toBe('agentkit-tastes');
  });

  // The mutation this exists for: drop the exclusion from the project layer and
  // the same file is read twice — once as project, once as external — and the
  // project reading wins, silently promoting a source above the repository.
  test('nothing under external/ is ever counted as a project taste', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': BOTH,
      '.agentkit/tastes/own-rule.md': project('own-rule'),
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste('release-tier'),
      '.agentkit/tastes/external/business-tastes/commit-style.md': taste('commit-style'),
    });
    const { tastes } = resolveTastes(cwd, home, {});

    expect(tastes.filter((entry) => entry.layer === 'project').map((entry) => entry.name))
      .toEqual(['own-rule']);
    expect(tastes.filter((entry) => entry.layer === 'external').map((entry) => entry.name))
      .toEqual(['commit-style', 'release-tier']);
  });

  test('the repository\'s own taste still beats the source of the same name', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': ONE,
      '.agentkit/tastes/release-tier.md': project('release-tier', 'the repository decides'),
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste('release-tier'),
    });
    const { tastes } = resolveTastes(cwd, home, {});

    expect(tastes).toHaveLength(1);
    expect(tastes[0]?.layer).toBe('project');
    expect(tastes[0]?.shadows).toEqual(['external']);
  });

  test('a category directory of the owner\'s own is read as project, not as a source', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': ONE,
      '.agentkit/tastes/git/commit-style.md': project('commit-style'),
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste('release-tier'),
    });
    const { tastes } = resolveTastes(cwd, home, {});

    expect(tastes.find((entry) => entry.name === 'commit-style')?.layer).toBe('project');
  });
});

// `external` names the subtree, so it cannot also name a taste or a category:
// both would sit in a tree something else reads by position, and the reading
// would be wrong rather than merely odd.
describe('external is a reserved name at the tastes root', () => {
  function lint(files: Record<string, string>): string[] {
    const root = scratch(files);
    return lintTastePath(join(root, '.agentkit', 'tastes'));
  }

  test('a taste cannot take the name external', () => {
    const errors = lint({ '.agentkit/tastes/external.md': project('external') });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('reserved');
    expect(errors[0]).toContain('external');
  });

  test('a category directory named external is refused, with the reason', () => {
    const errors = lint({ '.agentkit/tastes/git/external/commit-style.md': project('commit-style') });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('git/external');
    expect(errors[0]).toContain('reserved');
  });

  test('the reserved name costs the owner\'s own tastes nothing', () => {
    expect(lint({
      '.agentkit/tastes/git/commit-style.md': project('commit-style'),
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste('release-tier'),
    })).toEqual([]);
  });
});

// One invocation on the root has to be both correct and clean, or the lint the
// skill tells people to run is a lint nobody can run on the folder they have.
describe('linting the tastes root lints the owner\'s tastes and each source', () => {
  function lint(files: Record<string, string>): string[] {
    const root = scratch(files);
    return lintTastePath(join(root, '.agentkit', 'tastes'));
  }

  test('one name defined by two sources is the stacking, not a collision', () => {
    expect(lint({
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste('release-tier'),
      '.agentkit/tastes/external/business-tastes/release-tier.md': taste('release-tier'),
    })).toEqual([]);
  });

  test('a name defined twice inside one source is still that source being broken', () => {
    const errors = lint({
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste('release-tier'),
      '.agentkit/tastes/external/agentkit-tastes/git/release-tier.md': taste('release-tier'),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate');
  });

  test('the owner\'s own tastes are one scope, and a source cannot collide with them', () => {
    expect(lint({
      '.agentkit/tastes/release-tier.md': project('release-tier'),
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste('release-tier'),
    })).toEqual([]);
  });

  test('a duplicate among the owner\'s own tastes is still reported', () => {
    const errors = lint({
      '.agentkit/tastes/release-tier.md': project('release-tier'),
      '.agentkit/tastes/git/release-tier.md': project('release-tier'),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate');
  });

  test('a broken file is named by its path from the root, whichever origin it has', () => {
    const errors = lint({
      '.agentkit/tastes/own.md': project('own').replace('name: own', 'name: Own'),
      '.agentkit/tastes/external/agentkit-tastes/theirs.md': taste('theirs').replace(
        'name: theirs',
        'name: Theirs',
      ),
    });

    expect(errors.join('\n')).toContain('own.md');
    expect(errors.join('\n')).toContain('external/agentkit-tastes/theirs.md');
  });
});

// One release of grace: a clone that predates the move still reads its policy,
// and the next sync relocates it rather than leaving two trees to reconcile.
describe('a tree still at the old tastes-vendor location', () => {
  const legacy = {
    '.agentkit/config.yaml': ONE,
    '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': taste('release-tier'),
  };

  test('resolve still reads it, and says where it belongs now', () => {
    const { cwd, home } = where(legacy);
    const { tastes, warnings } = resolveTastes(cwd, home, {});

    expect(tastes.map((entry) => entry.name)).toEqual(['release-tier']);
    expect(tastes[0]?.layer).toBe('external');
    expect(warnings.join('\n')).toContain('.agentkit/tastes/external');
    expect(warnings.filter((warning) => warning.includes('tastes-vendor'))).toHaveLength(1);
  });

  test('the new location wins outright where both exist', () => {
    const { cwd, home } = where({
      ...legacy,
      '.agentkit/tastes/external/agentkit-tastes/release-tier.md': taste(
        'release-tier',
        {},
        'the moved copy',
      ),
    });
    const { tastes, warnings } = resolveTastes(cwd, home, {});

    expect(tastes[0]?.path).toContain(join('.agentkit', 'tastes', 'external'));
    expect(warnings.join('\n')).not.toContain('tastes-vendor');
  });

  test('sync moves it under the tastes tree, and reports the move', async () => {
    const upstream = remote({ 'release-tier.md': taste('release-tier') });
    upstream.tag('v1');
    const cwd = scratch({
      '.agentkit/config.yaml': config(
        source(upstream.url, { ref: 'v1', name: 'agentkit-tastes' }),
      ),
      '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': taste('release-tier'),
    });

    const result = await syncSources({ cwd, home: scratch(), env: {}, today: '2026-08-06' });

    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, '.agentkit', 'tastes-vendor'))).toBe(false);
    expect(treeOf(join(cwd, '.agentkit', 'tastes', 'external', 'agentkit-tastes'))).toEqual({
      'release-tier.md': taste('release-tier'),
    });
    expect(result.report.join('\n')).toContain('tastes-vendor');
    expect(result.report.join('\n')).toContain('.agentkit/tastes/external');
  });
});

// The sync owns `external/` and the lock. The files beside them are the
// owner's, and a prune that reached one would delete a taste nobody vendored.
describe('sync writes under external/ and nowhere else in the tastes tree', () => {
  test('a hand-written project taste survives a sync that prunes an undeclared source', async () => {
    const upstream = remote({ 'release-tier.md': taste('release-tier') });
    upstream.tag('v1');
    const own = project('own-rule');
    const cwd = scratch({
      '.agentkit/config.yaml': config(
        source(upstream.url, { ref: 'v1', name: 'agentkit-tastes' }),
      ),
      '.agentkit/tastes/own-rule.md': own,
      '.agentkit/tastes/git/branch-names.md': project('branch-names'),
      '.agentkit/tastes/external/left-behind/commit-style.md': taste('commit-style'),
    });

    const result = await syncSources({ cwd, home: scratch(), env: {}, today: '2026-08-06' });

    expect(result.ok).toBe(true);
    expect(result.report.join('\n')).toContain('left-behind');
    expect(existsSync(join(cwd, '.agentkit', 'tastes', 'external', 'left-behind'))).toBe(false);
    expect(treeOf(join(cwd, '.agentkit', 'tastes'))).toEqual({
      'own-rule.md': own,
      [join('git', 'branch-names.md')]: project('branch-names'),
      [join('external', 'agentkit-tastes', 'release-tier.md')]: taste('release-tier'),
    });
  });
});
