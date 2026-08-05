import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncSources } from '../../skills/taste/scripts/sync.ts';
import { removeScratch, type Remote, remote, scratch, taste, treeOf } from './fixtures.ts';

afterEach(removeScratch);

const TODAY = '2026-08-05';

function config(source: Record<string, string>): string {
  const [first, ...rest] = Object.entries(source);
  const head = `    - ${first?.[0]}: ${first?.[1]}`;
  const tail = rest.map(([key, value]) => `      ${key}: ${value}`);
  return `taste:\n  sources:\n${[head, ...tail].join('\n')}\n`;
}

function project(upstream: Remote, extra: Record<string, string> = {}): string {
  return config({ repo: upstream.url, ref: 'v1', name: 'agentkit-tastes', ...extra });
}

function sync(cwd: string) {
  return syncSources({ cwd, home: scratch(), env: {}, today: TODAY });
}

function upstream(files: Record<string, string> = { 'release-tier.md': taste('release-tier') }) {
  const source = remote(files);
  source.tag('v1');
  return source;
}

function vendor(cwd: string, name = 'agentkit-tastes'): string {
  return join(cwd, '.agentkit', 'tastes-vendor', name);
}

function lockOf(cwd: string): string {
  return readFileSync(join(cwd, '.agentkit', 'tastes.lock'), 'utf-8');
}

describe('sync vendors a source into the working tree', () => {
  test('the snapshot is the source\'s taste files, contents and all', () => {
    const source = upstream({
      'release-tier.md': taste('release-tier'),
      'git/commit-style.md': taste('commit-style'),
    });
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });

    const result = sync(cwd);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(treeOf(vendor(cwd))).toEqual({
      'release-tier.md': taste('release-tier'),
      'git/commit-style.md': taste('commit-style'),
    });
  });

  test('the lock pins the exact commit, with the repo, the ref and the date', () => {
    const source = upstream();
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });

    sync(cwd);

    const line = lockOf(cwd).split('\n').find((row) => row.startsWith('agentkit-tastes'));
    expect(line?.split('\t')).toEqual([
      'agentkit-tastes',
      source.url,
      'v1',
      source.head(),
      TODAY,
    ]);
  });

  // The vendored tree is what an agent reads as policy, so nothing that is not
  // a taste rides in with it — least of all something executable.
  test('only taste files cross the boundary', () => {
    const source = upstream({
      'release-tier.md': taste('release-tier'),
      'install.sh': '#!/bin/sh\necho pwned\n',
    });
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });

    sync(cwd);

    expect(Object.keys(treeOf(vendor(cwd)))).toEqual(['release-tier.md']);
  });

  test('path narrows the source to the subdirectory that holds the tastes', () => {
    const source = upstream({
      'README.md': '# not a taste\n',
      'tastes/release-tier.md': taste('release-tier'),
    });
    const cwd = scratch({ '.agentkit/config.yaml': project(source, { path: 'tastes' }) });

    const result = sync(cwd);

    expect(result.errors).toEqual([]);
    expect(Object.keys(treeOf(vendor(cwd)))).toEqual(['release-tier.md']);
  });

  test('nothing outside tastes-vendor and the lock is touched', () => {
    const source = upstream();
    const cwd = scratch({
      '.agentkit/config.yaml': project(source),
      '.agentkit/tastes/local.md': taste('local', { scope: 'project' }),
      'README.md': '# the repository\n',
    });
    const before = treeOf(cwd);

    sync(cwd);

    const after = treeOf(cwd);
    const touched = Object.keys({ ...before, ...after })
      .filter((path) => before[path] !== after[path])
      .sort();
    expect(touched).toEqual(['.agentkit/tastes-vendor/agentkit-tastes/release-tier.md', '.agentkit/tastes.lock']);
  });
});

describe('a re-sync is a no-op until the upstream moves', () => {
  test('running it twice changes not one byte', () => {
    const source = upstream();
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });

    sync(cwd);
    const first = treeOf(cwd);
    const second = syncSources({ cwd, home: scratch(), env: {}, today: '2026-09-01' });

    expect(second.errors).toEqual([]);
    expect(treeOf(cwd)).toEqual(first);
  });

  // The date says when this pin was reviewed, not when someone last ran a
  // command — a date that moved on every run would make every sync a diff.
  test('the pin date is carried forward while the commit stands still', () => {
    const source = upstream();
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });

    sync(cwd);
    syncSources({ cwd, home: scratch(), env: {}, today: '2026-09-01' });

    expect(lockOf(cwd)).toContain(TODAY);
    expect(lockOf(cwd)).not.toContain('2026-09-01');
  });

  const V1 = {
    'release-tier.md': taste('release-tier', {}, 'Cut patch releases.'),
    'commit-style.md': taste('commit-style'),
  };
  const V2 = {
    'release-tier.md': taste('release-tier', {}, 'Cut minor releases.'),
    'branch-names.md': taste('branch-names'),
  };

  function advance(source: Remote): void {
    source.commit(V2, ['commit-style.md']);
    source.tag('v2');
  }

  test('an upstream commit moves nothing until the ref in config does', () => {
    const source = upstream(V1);
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });
    sync(cwd);
    const pinned = treeOf(cwd);

    advance(source);
    const result = syncSources({ cwd, home: scratch(), env: {}, today: '2026-09-01' });

    expect(result.errors).toEqual([]);
    expect(treeOf(cwd)).toEqual(pinned);
  });

  test('bumping the ref replaces, adds and removes exactly what upstream did', () => {
    const source = upstream(V1);
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });
    sync(cwd);

    advance(source);
    writeFileSync(join(cwd, '.agentkit', 'config.yaml'), project(source, { ref: 'v2' }));
    const result = syncSources({ cwd, home: scratch(), env: {}, today: '2026-09-01' });

    expect(result.errors).toEqual([]);
    expect(treeOf(vendor(cwd))).toEqual(V2);
    expect(lockOf(cwd)).toContain(source.head());
    expect(lockOf(cwd)).toContain('2026-09-01');
  });
});

describe('a source is linted before it is allowed into the tree', () => {
  const BROKEN = {
    'release-tier.md': taste('release-tier'),
    'commit-style.md': taste('commit-style').replace('name: commit-style', 'name: Commit_Style'),
  };

  test('an invalid taste refuses the whole source, naming the file', () => {
    const source = upstream(BROKEN);
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });

    const result = sync(cwd);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('commit-style.md');
    expect(result.errors.join('\n')).toContain('agentkit-tastes');
  });

  test('and none of it lands — not even the files that were valid', () => {
    const source = upstream(BROKEN);
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });

    sync(cwd);

    expect(existsSync(vendor(cwd))).toBe(false);
    expect(existsSync(join(cwd, '.agentkit', 'tastes.lock'))).toBe(false);
  });

  test('a good snapshot already in the tree survives a bad bump', () => {
    const source = upstream({ 'release-tier.md': taste('release-tier', {}, 'Cut patch releases.') });
    const cwd = scratch({ '.agentkit/config.yaml': project(source) });
    sync(cwd);
    const good = treeOf(vendor(cwd));
    const pinned = lockOf(cwd);

    source.commit({ 'release-tier.md': taste('release-tier').replace('name:', 'nome:') });
    source.tag('v2');
    writeFileSync(join(cwd, '.agentkit', 'config.yaml'), project(source, { ref: 'v2' }));
    const result = syncSources({ cwd, home: scratch(), env: {}, today: '2026-09-01' });

    expect(result.ok).toBe(false);
    expect(treeOf(vendor(cwd))).toEqual(good);
    expect(lockOf(cwd)).toBe(pinned);
  });
});

describe('sync answers for what it cannot do', () => {
  test('reference mode is refused as deferred, and fetches nothing', () => {
    const source = upstream();
    const cwd = scratch({ '.agentkit/config.yaml': project(source, { mode: 'reference' }) });

    const result = sync(cwd);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('deferred');
    expect(existsSync(join(cwd, '.agentkit', 'tastes-vendor'))).toBe(false);
  });

  test('an unreachable source is an error, not a half-written directory', () => {
    const cwd = scratch({
      '.agentkit/config.yaml': config({
        repo: 'file:///nonexistent/tastes.git',
        ref: 'v1',
        name: 'agentkit-tastes',
      }),
    });

    const result = sync(cwd);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('agentkit-tastes');
    expect(existsSync(vendor(cwd))).toBe(false);
  });

  test('a ref that does not exist upstream names the ref', () => {
    const source = upstream();
    const cwd = scratch({ '.agentkit/config.yaml': project(source, { ref: 'v9' }) });

    const result = sync(cwd);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('v9');
  });

  test('no sources declared writes nothing at all, and says so', () => {
    const cwd = scratch({
      '.agentkit/config.yaml': 'taste:\n  enabled: true\n',
      '.agentkit/tastes-vendor/left-behind/release-tier.md': taste('release-tier'),
    });
    const before = treeOf(cwd);

    const result = sync(cwd);

    expect(result.ok).toBe(true);
    expect(result.report.join('\n')).toContain('no sources');
    expect(treeOf(cwd)).toEqual(before);
  });

  test('a source dropped from the config takes its vendored copy with it', () => {
    const source = upstream();
    const cwd = scratch({
      '.agentkit/config.yaml': project(source),
      '.agentkit/tastes-vendor/business-tastes/commit-style.md': taste('commit-style'),
    });

    const result = sync(cwd);

    expect(existsSync(vendor(cwd, 'business-tastes'))).toBe(false);
    expect(result.report.join('\n')).toContain('business-tastes');
  });
});
