import { describe, expect, test } from 'bun:test';
import {
  currentRelease,
  currentVersionLabel,
  versionOptions,
} from '../../docs/site/src/lib/release.ts';

// The picker said "Latest" with no version, so a reader had no way to tell which
// release the docs described. It has to come from the tag being built, and it must
// not come from a committed file: the tag is created after the commit it points at,
// so a drift-checked value would disagree with the tree at tag time.
describe('the current version label names the release', () => {
  test('the CI-provided tag wins, needing no git', () => {
    expect(currentVersionLabel({ env: 'v0.4.5' })).toBe('v0.4.5');
  });

  test('surrounding whitespace from a shell is tolerated', () => {
    expect(currentRelease({ env: '  v1.2.3\n' })).toBe('v1.2.3');
  });

  test('git describe is the local fallback', () => {
    expect(currentVersionLabel({ describe: () => 'v0.4.4\n' })).toBe('v0.4.4');
  });

  // The label renders inside the sidebar's own parentheses; a suffix like
  // "(latest)" doubles them on every page, which is how this shipped once.
  test('the composed sidebar label carries no nested parentheses', () => {
    const composed = `Introduction (${currentVersionLabel({ env: 'v1.0.0' })})`;
    expect(composed).toBe('Introduction (v1.0.0)');
  });

  test('the env value is preferred over git', () => {
    expect(currentVersionLabel({ env: 'v9.9.9', describe: () => 'v0.0.1' })).toBe(
      'v9.9.9',
    );
  });

  // With no version to state, a bare "latest" is honest; inventing one is not.
  test.each([
    ['no sources at all', {}],
    ['a describe that throws', { describe: () => { throw new Error('no tags'); } }],
    ['a non-release ref', { env: 'main' }],
    ['a release candidate', { env: 'v0.4.5-rc1' }],
    ['an abbreviated tag', { env: 'v0.4' }],
    ['empty output', { describe: () => '' }],
  ])('%s yields a bare Latest rather than a guess', (_label, sources) => {
    expect(currentVersionLabel(sources)).toBe('latest');
  });
});

// The select is how a reader reaches an archived version and how they see which
// one they are reading; a release once shipped with neither, and the archives
// were only findable from a sidebar group.
describe('the version select offers the release and the archives', () => {
  const archived = [{ slug: '0.4', label: 'v0.4' }];

  test('the current release leads and says it is the current one', () => {
    expect(versionOptions('v0.6.0', archived)[0]).toEqual({
      label: 'v0.6.0 (latest)',
      path: '/docs/',
    });
  });

  test('an unresolved release states no number it cannot back up', () => {
    expect(versionOptions('', archived)[0]?.label).toBe('latest');
  });

  // Base-relative paths would keep an archived reader inside the archive, which
  // is the one place the select exists to escape.
  test('each archive is an absolute path under the docs root', () => {
    expect(versionOptions('v0.6.0', archived).map(({ path }) => path)).toEqual([
      '/docs/',
      '/docs/0.4/',
    ]);
  });

  test('no archives leaves the current release as the only option', () => {
    expect(versionOptions('v0.6.0', [])).toHaveLength(1);
  });
});
