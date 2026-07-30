import { describe, expect, test } from 'bun:test';
import {
  currentRelease,
  currentVersionLabel,
} from '../../docs/site/src/lib/release.ts';

// The picker said "Latest" with no version, so a reader had no way to tell which
// release the docs described. It has to come from the tag being built, and it must
// not come from a committed file: the tag is created after the commit it points at,
// so a drift-checked value would disagree with the tree at tag time.
describe('the current version label names the release', () => {
  test('the CI-provided tag wins, needing no git', () => {
    expect(currentVersionLabel({ env: 'v0.4.5' })).toBe('v0.4.5 (latest)');
  });

  test('surrounding whitespace from a shell is tolerated', () => {
    expect(currentRelease({ env: '  v1.2.3\n' })).toBe('v1.2.3');
  });

  test('git describe is the local fallback', () => {
    expect(currentVersionLabel({ describe: () => 'v0.4.4\n' })).toBe('v0.4.4 (latest)');
  });

  test('the env value is preferred over git', () => {
    expect(currentVersionLabel({ env: 'v9.9.9', describe: () => 'v0.0.1' })).toBe(
      'v9.9.9 (latest)',
    );
  });

  // The version leads the label because the select truncates. With no version to
  // lead with, a bare "Latest" is honest; inventing a number would not be.
  test.each([
    ['no sources at all', {}],
    ['a describe that throws', { describe: () => { throw new Error('no tags'); } }],
    ['a non-release ref', { env: 'main' }],
    ['a release candidate', { env: 'v0.4.5-rc1' }],
    ['an abbreviated tag', { env: 'v0.4' }],
    ['empty output', { describe: () => '' }],
  ])('%s yields a bare Latest rather than a guess', (_label, sources) => {
    expect(currentVersionLabel(sources)).toBe('Latest');
  });
});
