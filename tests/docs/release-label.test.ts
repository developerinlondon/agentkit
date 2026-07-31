import { describe, expect, test } from 'bun:test';
import {
  ARCHIVE_LIMIT,
  currentRelease,
  currentVersionLabel,
  selectArchives,
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
  const archived = [{ slug: '0.4', tag: 'v0.4.5', label: 'v0.4' }];

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

// The archive list is derived from the tags rather than curated, so the rule
// that picks them is the thing that has to be pinned: a hand-kept manifest went
// stale silently, and a wrong rule here offers versions that were never built.
describe('archived releases are selected from the tags', () => {
  const tags = ['v0.4.5', 'v0.5.0', 'v0.6.0', 'v0.5.3'];

  test('newest first, so the picker reads downwards', () => {
    expect(selectArchives(tags, 'v0.6.1').map(({ tag }) => tag)).toEqual([
      'v0.6.0',
      'v0.5.3',
      'v0.5.0',
      'v0.4.5',
    ]);
  });

  // Numeric, not lexicographic: "v0.10.0" sorts below "v0.9.0" as a string, and
  // the picker would start naming the wrong release as the newest archive.
  test('ordering is numeric per component', () => {
    expect(selectArchives(['v0.9.0', 'v0.10.0', 'v0.10.2'], 'v1.0.0').map(({ tag }) => tag))
      .toEqual(['v0.10.2', 'v0.10.0', 'v0.9.0']);
  });

  test('the release being built is not an archive of itself', () => {
    expect(selectArchives(tags, 'v0.6.0').map(({ tag }) => tag)).not.toContain('v0.6.0');
  });

  // A tag newer than the build exists whenever an older release is rebuilt, and
  // offering it would send readers forwards from an archive.
  test('anything newer than the release being built is dropped', () => {
    expect(selectArchives(tags, 'v0.5.0').map(({ tag }) => tag)).toEqual(['v0.4.5']);
  });

  test('the cap bounds the list, keeping the newest', () => {
    const many = Array.from({ length: 30 }, (_, index) => `v1.0.${index}`);
    const selected = selectArchives(many, 'v2.0.0', 3);
    expect(selected.map(({ tag }) => tag)).toEqual(['v1.0.29', 'v1.0.28', 'v1.0.27']);
  });

  test('the default cap is the documented knob', () => {
    const many = Array.from({ length: 25 }, (_, index) => `v1.0.${index}`);
    expect(selectArchives(many, 'v2.0.0')).toHaveLength(ARCHIVE_LIMIT);
  });

  test.each([
    ['a release candidate', 'v1.2.3-rc1'],
    ['an abbreviated tag', 'v0.4'],
    ['a bare branch name', 'main'],
    ['an unprefixed version', '1.2.3'],
    ['an empty entry', ''],
  ])('%s is not a release and never becomes an archive', (_label, tag) => {
    expect(selectArchives(['v1.0.0', tag], 'v2.0.0').map((entry) => entry.tag)).toEqual(['v1.0.0']);
  });

  test('a tag listed twice is offered once', () => {
    expect(selectArchives(['v1.0.0', 'v1.0.0'], 'v2.0.0')).toHaveLength(1);
  });

  // The slug is the mount path; a leading "v" would publish /docs/v0.5.3/ while
  // the picker linked /docs/0.5.3/.
  test('the slug drops the v and the label keeps the tag verbatim', () => {
    expect(selectArchives(['v0.5.3'], 'v0.6.0')).toEqual([
      { slug: '0.5.3', tag: 'v0.5.3', label: 'v0.5.3' },
    ]);
  });

  test('an unresolved current release archives every tag it found', () => {
    expect(selectArchives(tags, '')).toHaveLength(4);
  });
});
