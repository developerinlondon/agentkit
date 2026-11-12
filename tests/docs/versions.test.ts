import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { currentRelease, versionList } from '../../docs/hextra/scripts/versions';
import { releaseTaggedRepo } from '../fixtures/release-tags';

test('the docs name the release tag when the hugo/diagrams module tag shares its commit', () => {
  const repo = releaseTaggedRepo('v9.9.9');
  try {
    const current = currentRelease(repo);
    expect(current).toBe('v9.9.9');
    expect(versionList(current, [])[0]?.label).toBe('v9.9.9 (latest)');
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});
