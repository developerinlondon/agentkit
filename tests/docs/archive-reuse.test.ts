import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
const BUILDER = join(REPO, 'docs', 'site', 'build-archives.sh');

const TAG = 'v1.0.0';
const SLUG = '1.0.0';
const HASH = 'abcdef0123456789';

let root: string;
let site: string;
let bin: string;

function write(relative: string, body: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function git(...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function stub(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// The list module, the injector and the astro build are all reached through
// these; the reuse decision under test happens before any of them run.
function stubTools(): void {
  stub(
    'bun',
    [
      '#!/usr/bin/env bash',
      'set -eu',
      `ENTRIES=${JSON.stringify(join(root, '.entries'))}`,
      `INJECTED=${JSON.stringify(join(root, '.injected'))}`,
      'case "${1:-}" in',
      '  install) exit 0 ;;',
      '  *list-archives*) cat "$ENTRIES"; exit 0 ;;',
      '  *inject-banner*) printf "%s\\n" "$2" >> "$INJECTED"; exit 0 ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  stub(
    'node',
    [
      '#!/usr/bin/env bash',
      'set -eu',
      `BUILDS=${JSON.stringify(join(root, '.builds'))}`,
      'printf "build\\n" >> "$BUILDS"',
      'mkdir -p dist',
      'printf "<html><body>archived</body></html>" > dist/index.html',
      'exit 0',
    ].join('\n'),
  );
}

// Stands in for the published stamp: present means the site answers with it,
// absent means the fetch fails the way an unreachable or 404 site does.
function stubPublishedStamp(body: string | null): void {
  const path = join(root, '.published-stamp');
  if (body === null) {
    rmSync(path, { force: true });
  } else {
    writeFileSync(path, body);
  }
  stub(
    'curl',
    [
      '#!/usr/bin/env bash',
      'set -eu',
      `STAMP=${JSON.stringify(path)}`,
      '[ -f "$STAMP" ] || exit 22',
      'cat "$STAMP"',
      'exit 0',
    ].join('\n'),
  );
}

function entries(line: string): void {
  writeFileSync(join(root, '.entries'), `${line}\n`);
}

function build(env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [join(site, 'build-archives.sh'), 'dist'], {
    encoding: 'utf-8',
    cwd: site,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      AGENTKIT_SITE_URL: 'https://site.example.test',
      ...env,
    },
  });
}

const built = () => existsSync(join(root, '.builds'));
const reusedList = () => {
  const path = join(site, 'dist', '.reused-archives');
  return existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean) : [];
};
const stampFile = () => {
  const path = join(site, 'dist', SLUG, 'archive-stamp.txt');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
};

let tagSha: string;
let expectedStamp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-archive-reuse-'));
  site = join(root, 'docs', 'site');
  bin = join(root, '.bin');
  mkdirSync(bin, { recursive: true });

  // The tagged tree is what the builder checks out and rebases, so it needs the
  // two shapes the rebase touches.
  write('docs/site/astro.config.mjs', 'export default { base: "/docs", };\n');
  write('docs/site/src/content/docs/index.md', '# archived\n\n[link](/docs/thing/)\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('tag', TAG);
  tagSha = git('rev-parse', `refs/tags/${TAG}^{commit}`);
  expectedStamp = `${TAG} ${tagSha} ${HASH}`;

  cpSync(BUILDER, join(site, 'build-archives.sh'));
  chmodSync(join(site, 'build-archives.sh'), 0o755);
  mkdirSync(join(site, 'dist'), { recursive: true });
  entries(`${SLUG}\t${TAG}\t${HASH}`);
  stubTools();
  stubPublishedStamp(null);
});

afterEach(() => {
  spawnSync('git', ['-C', root, 'worktree', 'prune'], { encoding: 'utf-8' });
  rmSync(root, { recursive: true, force: true });
});

// Rebuilding a version whose tag cannot change is the waste; the stamp is what
// makes "already published" a fact the builder can check rather than assume.
describe('an archive is rebuilt only when its stamp would change', () => {
  test('a matching published stamp skips the build entirely', () => {
    stubPublishedStamp(`${expectedStamp}\n`);
    const result = build({ AGENTKIT_ARCHIVE_REUSE: '1' });

    expect(result.status, result.stderr).toBe(0);
    expect(built()).toBe(false);
    expect(reusedList()).toEqual([SLUG]);
    expect(existsSync(join(site, 'dist', SLUG))).toBe(false);
    expect(result.stdout).toContain('reused the published build');
  });

  test('a different banner hash rebuilds', () => {
    stubPublishedStamp(`${TAG} ${tagSha} 0000000000000000\n`);
    const result = build({ AGENTKIT_ARCHIVE_REUSE: '1' });

    expect(result.status, result.stderr).toBe(0);
    expect(built()).toBe(true);
    expect(reusedList()).toEqual([]);
    expect(stampFile()).toBe(`${expectedStamp}\n`);
  });

  test('a different tag commit rebuilds', () => {
    stubPublishedStamp(`${TAG} 0000000000000000000000000000000000000000 ${HASH}\n`);
    const result = build({ AGENTKIT_ARCHIVE_REUSE: '1' });

    expect(result.status, result.stderr).toBe(0);
    expect(built()).toBe(true);
    expect(reusedList()).toEqual([]);
  });

  // Every uncertain answer has to build: publishing a stale archive because a
  // fetch blipped is worse than spending the build.
  test('an unreachable site rebuilds rather than assuming', () => {
    stubPublishedStamp(null);
    const result = build({ AGENTKIT_ARCHIVE_REUSE: '1' });

    expect(result.status, result.stderr).toBe(0);
    expect(built()).toBe(true);
    expect(reusedList()).toEqual([]);
  });

  test('an empty published stamp rebuilds', () => {
    stubPublishedStamp('');
    const result = build({ AGENTKIT_ARCHIVE_REUSE: '1' });

    expect(result.status, result.stderr).toBe(0);
    expect(built()).toBe(true);
  });

  // Reuse belongs to the deploy. A local build that quietly skipped archives
  // would leave the only path that exercises them the one that skips them.
  test('without the deploy opt-in a matching stamp still builds', () => {
    stubPublishedStamp(`${expectedStamp}\n`);
    const result = build();

    expect(result.status, result.stderr).toBe(0);
    expect(built()).toBe(true);
    expect(reusedList()).toEqual([]);
  });

  test('the stamp names the tag, its commit and the banner', () => {
    const result = build();

    expect(result.status, result.stderr).toBe(0);
    expect(stampFile()).toBe(`${expectedStamp}\n`);
  });

  // The list drives what the deploy spares from pruning, so one left behind by
  // an earlier run would protect objects this run did not reuse.
  test('a list left by an earlier run does not survive into this one', () => {
    writeFileSync(join(site, 'dist', '.reused-archives'), '9.9.9\n');
    const result = build({ AGENTKIT_ARCHIVE_REUSE: '1' });

    expect(result.status, result.stderr).toBe(0);
    expect(reusedList()).toEqual([]);
  });

  test('an entry with no banner hash is refused rather than stamped blank', () => {
    entries(`${SLUG}\t${TAG}`);
    const result = build({ AGENTKIT_ARCHIVE_REUSE: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no banner hash');
  });
});
