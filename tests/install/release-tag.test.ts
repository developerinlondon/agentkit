import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { releaseTaggedRepo } from '../fixtures/release-tags';

const repoRoot = dirname(dirname(import.meta.dir));

function versionStamp(repo: string): string {
  const source = readFileSync(join(repoRoot, 'install.sh'), 'utf-8');
  const fn = /^write_version_stamp\(\) \{\n[\s\S]*?\n\}\n/m.exec(source)?.[0];
  if (fn === undefined) throw new Error('write_version_stamp not found in install.sh');
  const home = mkdtempSync(join(tmpdir(), 'agentkit-stamp-home-'));
  try {
    const r = spawnSync('bash', ['-c', `${fn}\nwrite_version_stamp`], {
      encoding: 'utf-8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', HOME: home, REPO_DIR: repo, AGENTKIT_HOME: home },
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return readFileSync(join(home, 'version'), 'utf-8').split('\n')[0];
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

describe('a release commit that also carries the hugo/diagrams module tag', () => {
  test('the install stamp names the release tag on the release commit', () => {
    const repo = releaseTaggedRepo('v9.9.9');
    try {
      expect(versionStamp(repo)).toBe('v9.9.9');
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  test('the install stamp describes later commits from the release tag', () => {
    const repo = releaseTaggedRepo('v9.9.9', 1);
    try {
      expect(versionStamp(repo)).toMatch(/^v9\.9\.9-1-g[0-9a-f]+$/);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  test('every git describe in the repo is limited to release tags', () => {
    const r = spawnSync('git', ['-C', repoRoot, 'grep', '-nE', 'describe.{0,8}--tags', '--', ':!tests', ':!*.md'], {
      encoding: 'utf-8',
    });
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => !l.includes("'v[0-9]*'"))).toEqual([]);
  });
});
