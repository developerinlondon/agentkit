import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Layer, resolveTastes } from '../../skills/taste/scripts/resolve.ts';
import { readSources } from '../../skills/taste/scripts/sources.ts';
import { type SyncResult, syncSources } from '../../skills/taste/scripts/sync.ts';
import {
  config,
  type Remote,
  remote,
  removeScratch,
  scratch,
  source,
  taste,
  treeOf,
} from './fixtures.ts';

afterEach(removeScratch);

const TODAY = '2026-08-06';
const GENERIC = 'git@github.com:developerinlondon/agentkit-tastes.git';
const CENTRAL = 'git@github.com:developerinlondon/business-tastes.git';

const USER_CONFIG = '.config/agentkit/config.yaml';

function where(files: Record<string, string>, homeFiles: Record<string, string> = {}) {
  return { cwd: scratch(files), home: scratch(homeFiles) };
}

function upstream(files: Record<string, string>): Remote {
  const built = remote(files);
  built.tag('v1');
  return built;
}

function lockOf(root: string): string {
  return readFileSync(join(root, '.agentkit', 'tastes.lock'), 'utf-8');
}

function vendored(root: string, name: string): string {
  return join(root, '.agentkit', 'tastes', 'external', name);
}

// The owner's ask: declare it once on the machine and every repository picks it
// up. Nothing is copied into any repository, which is also what makes it the
// scope a private source belongs in.
describe('a source declared on the machine binds in every repository', () => {
  const machine = {
    [USER_CONFIG]: config(source(CENTRAL, { ref: 'v1', name: 'business' })),
    '.agentkit/tastes/external/business/release-tier.md': taste('release-tier'),
  };

  test('a repository that declares nothing still reads it', () => {
    const { cwd, home } = where({}, machine);
    const { tastes, warnings } = resolveTastes(cwd, home, {});

    expect(tastes.map((entry) => entry.name)).toEqual(['release-tier']);
    expect(tastes[0]?.layer).toBe('user-external');
    expect(tastes[0]?.source).toBe('business');
    expect(warnings).toEqual([]);
  });

  test('nothing about it is written into the repository', () => {
    const { cwd, home } = where({}, machine);
    resolveTastes(cwd, home, {});

    expect(existsSync(join(cwd, '.agentkit'))).toBe(false);
  });

  test('a machine source declared but not vendored says to sync, naming the machine store', () => {
    const { cwd, home } = where({}, { [USER_CONFIG]: machine[USER_CONFIG] as string });
    const { warnings } = resolveTastes(cwd, home, {});

    expect(warnings.join('\n')).toContain('business');
    expect(warnings.join('\n')).toContain(join(home, '.agentkit', 'tastes', 'external'));
  });

  test('an undeclared directory in the machine store binds nothing, and is said out loud', () => {
    const { cwd, home } = where({}, {
      ...machine,
      '.agentkit/tastes/external/stowaway/commit-style.md': taste('commit-style'),
    });
    const { tastes, warnings } = resolveTastes(cwd, home, {});

    expect(tastes.map((entry) => entry.name)).toEqual(['release-tier']);
    expect(warnings.join('\n')).toContain('stowaway');
  });
});

// The reversal this build makes: the two lists used to shadow each other, so a
// machine declaration went silent the moment a repository declared one of its
// own. They are separate stores now, so both apply.
describe('a repository list and a machine list both apply', () => {
  function declared(project: string, user: string) {
    return readSources(
      scratch({ '.agentkit/config.yaml': project }),
      scratch({ [USER_CONFIG]: user }),
      {},
    );
  }

  test('both scopes contribute their sources', () => {
    const { sources, errors } = declared(
      config(source(GENERIC, { ref: 'v1', visibility: 'public' })),
      config(source(CENTRAL, { ref: 'v1' })),
    );

    expect(errors).toEqual([]);
    expect(sources.map((entry) => entry.name)).toEqual(['agentkit-tastes', 'business-tastes']);
    expect(sources.map((entry) => entry.scope)).toEqual(['project', 'user']);
  });

  test('the same source name at both scopes is two stores, not a collision', () => {
    const { sources, errors } = declared(
      config(source(GENERIC, { ref: 'v1', name: 'shared', visibility: 'public' })),
      config(source(CENTRAL, { ref: 'v1', name: 'shared' })),
    );

    expect(errors).toEqual([]);
    expect(sources).toHaveLength(2);
  });

  test('a machine source needs no visibility key — nothing of it is ever committed', () => {
    const { errors } = declared('brain:\n  taste:\n    enabled: true\n', config(source(CENTRAL, { ref: 'v1' })));

    expect(errors).toEqual([]);
  });
});

// The more specific location wins, and within a location the repository's own
// beat the ones it pulled in. Four layers, one direction.
describe('precedence runs project, project external, user, user external', () => {
  const PROJECT_OWN = '.agentkit/tastes/release-tier.md';
  const PROJECT_PULLED = '.agentkit/tastes/external/pulled/release-tier.md';
  const USER_OWN = '.agentkit/tastes/release-tier.md';
  const USER_PULLED = '.agentkit/tastes/external/machine/release-tier.md';

  function repository(...keep: string[]): Record<string, string> {
    const files: Record<string, string> = {
      '.agentkit/config.yaml': config(
        source(GENERIC, { ref: 'v1', name: 'pulled', visibility: 'public' }),
      ),
    };
    if (keep.includes(PROJECT_OWN)) {
      files[PROJECT_OWN] = taste('release-tier', { scope: 'project' }, 'project own');
    }
    if (keep.includes(PROJECT_PULLED)) files[PROJECT_PULLED] = taste('release-tier', {}, 'pulled');
    return files;
  }

  function machine(...keep: string[]): Record<string, string> {
    const files: Record<string, string> = {
      [USER_CONFIG]: config(source(CENTRAL, { ref: 'v1', name: 'machine' })),
    };
    if (keep.includes(USER_OWN)) {
      files[USER_OWN] = taste('release-tier', { scope: 'user' }, 'user own');
    }
    if (keep.includes(USER_PULLED)) files[USER_PULLED] = taste('release-tier', {}, 'machine');
    return files;
  }

  function winner(project: string[], user: string[]) {
    const at = where(repository(...project), machine(...user));
    return resolveTastes(at.cwd, at.home, {}).tastes[0];
  }

  test('the repository\'s own taste wins over all three below it', () => {
    const held = winner([PROJECT_OWN, PROJECT_PULLED], [USER_OWN, USER_PULLED]);

    expect(held?.layer).toBe('project');
    expect(held?.shadows).toEqual(['project-external', 'user', 'user-external'] as Layer[]);
  });

  test('without one of its own, the repository\'s pulled source wins', () => {
    const held = winner([PROJECT_PULLED], [USER_OWN, USER_PULLED]);

    expect(held?.layer).toBe('project-external');
    expect(held?.shadows).toEqual(['user', 'user-external'] as Layer[]);
  });

  // The layer that decides whether machine-level is usable at all: a taste in
  // the owner's home directory beats the sources that home pulled in, exactly
  // as a repository's own beats the ones it pulled in.
  test('the user\'s own taste wins over the machine source it pulled', () => {
    const held = winner([], [USER_OWN, USER_PULLED]);

    expect(held?.layer).toBe('user');
    expect(held?.shadows).toEqual(['user-external'] as Layer[]);
  });

  test('the machine source binds when nothing above it defines the name', () => {
    const held = winner([], [USER_PULLED]);

    expect(held?.layer).toBe('user-external');
    expect(held?.shadows).toEqual([]);
  });

  test('the winner names every source it shadowed, at either scope', () => {
    const held = winner([PROJECT_OWN, PROJECT_PULLED], [USER_OWN, USER_PULLED]);

    expect(held?.shadowedSources).toEqual(['pulled', 'machine']);
  });
});

describe('sync refreshes each scope into its own store', () => {
  interface Both {
    cwd: string;
    home: string;
    run(today?: string): Promise<SyncResult>;
  }

  function both(
    projectSources: string[],
    machineSources: string[],
    extra: { cwd?: Record<string, string>; home?: Record<string, string> } = {},
  ): Both {
    const cwd = scratch({
      ...(projectSources.length > 0 ? { '.agentkit/config.yaml': config(...projectSources) } : {}),
      ...extra.cwd,
    });
    const home = scratch({
      ...(machineSources.length > 0 ? { [USER_CONFIG]: config(...machineSources) } : {}),
      ...extra.home,
    });
    return {
      cwd,
      home,
      run: (today = TODAY) => syncSources({ cwd, home, env: {}, today }),
    };
  }

  function pulled(): string {
    return source(upstream({ 'release-tier.md': taste('release-tier') }).url, {
      ref: 'v1',
      name: 'public',
      visibility: 'public',
    });
  }

  function central(): string {
    return source(upstream({ 'commit-style.md': taste('commit-style') }).url, {
      ref: 'v1',
      name: 'business',
    });
  }

  test('a machine source lands in the home store, and never in the repository', async () => {
    const at = both([], [central()]);

    const result = await at.run();

    expect(result.errors).toEqual([]);
    expect(treeOf(vendored(at.home, 'business'))).toEqual({
      'commit-style.md': taste('commit-style'),
    });
    expect(existsSync(join(at.cwd, '.agentkit'))).toBe(false);
  });

  test('both scopes are refreshed in one run, and each is reported by name', async () => {
    const at = both([pulled()], [central()]);

    const result = await at.run();
    const report = result.report.join('\n');

    expect(result.errors).toEqual([]);
    expect(existsSync(vendored(at.cwd, 'public'))).toBe(true);
    expect(existsSync(vendored(at.home, 'business'))).toBe(true);
    expect(report).toContain('repository');
    expect(report).toContain('machine');
  });

  // Two stores, two locks. One file describing both would put a machine-local
  // pin in a repository's review surface, where nobody reviewing that
  // repository can see what it points at.
  test('each scope writes its own lock, pinning only its own sources', async () => {
    const at = both([pulled()], [central()]);

    await at.run();

    expect(lockOf(at.cwd)).toContain('public');
    expect(lockOf(at.cwd)).not.toContain('business');
    expect(lockOf(at.home)).toContain('business');
    expect(lockOf(at.home)).not.toContain('public');
  });

  test('re-running changes not one byte in either store', async () => {
    const at = both([pulled()], [central()]);

    await at.run();
    const first = { cwd: treeOf(at.cwd), home: treeOf(at.home) };
    const again = await at.run('2026-09-01');

    expect(again.errors).toEqual([]);
    expect(treeOf(at.cwd)).toEqual(first.cwd);
    expect(treeOf(at.home)).toEqual(first.home);
  });

  test('outside a repository the machine scope still syncs, and says the other is empty', async () => {
    const at = both([], [central()]);

    const result = await at.run();

    expect(result.ok).toBe(true);
    expect(existsSync(vendored(at.home, 'business'))).toBe(true);
    expect(result.report.join('\n')).toContain('no sources');
  });

  test('a machine source dropped from the config takes its snapshot with it', async () => {
    const at = both([], [central()], {
      home: { '.agentkit/tastes/external/left-behind/release-tier.md': taste('release-tier') },
    });

    const result = await at.run();

    expect(existsSync(vendored(at.home, 'left-behind'))).toBe(false);
    expect(result.report.join('\n')).toContain('left-behind');
  });

  // The machine store is the owner's own directory: the sweep that removes an
  // undeclared source must not reach the tastes they wrote by hand beside it.
  test('the user\'s own tastes survive a machine sync that prunes', async () => {
    const own = taste('tone', { scope: 'user' });
    const at = both([], [central()], {
      home: {
        '.agentkit/tastes/tone.md': own,
        '.agentkit/tastes/external/left-behind/release-tier.md': taste('release-tier'),
      },
    });

    await at.run();

    expect(treeOf(join(at.home, '.agentkit', 'tastes'))).toEqual({
      'tone.md': own,
      [join('external', 'business', 'commit-style.md')]: taste('commit-style'),
    });
  });

  // Staging keyed on the source name alone gave both scopes one checkout, so
  // the second store's fetch ran against the first store's git directory and
  // the whole sync died. A name is only unique within the scope that declared
  // it, which is the same reason the two stores hold separate locks.
  test('two scopes may name a source alike, and each lands its own upstream', async () => {
    const of = (body: string) => taste('release-tier', {}, body);
    const at = both(
      [source(upstream({ 'release-tier.md': of('the repository\'s own upstream') }).url, {
        ref: 'v1',
        name: 'shared',
        visibility: 'public',
      })],
      [source(upstream({ 'release-tier.md': of('the machine\'s own upstream') }).url, {
        ref: 'v1',
        name: 'shared',
      })],
    );

    const result = await at.run();

    expect(result.errors).toEqual([]);
    expect(treeOf(vendored(at.cwd, 'shared'))).toEqual({
      'release-tier.md': of('the repository\'s own upstream'),
    });
    expect(treeOf(vendored(at.home, 'shared'))).toEqual({
      'release-tier.md': of('the machine\'s own upstream'),
    });
  });

  test('a source the lint refuses at one scope leaves the other store untouched', async () => {
    const broken = upstream({
      'commit-style.md': taste('commit-style').replace('name: commit-style', 'name: Commit_Style'),
    });
    const at = both(
      [pulled()],
      [source(broken.url, { ref: 'v1', name: 'business' })],
    );

    const result = await at.run();

    expect(result.ok).toBe(false);
    expect(existsSync(vendored(at.cwd, 'public'))).toBe(false);
    expect(existsSync(vendored(at.home, 'business'))).toBe(false);
  });
});
