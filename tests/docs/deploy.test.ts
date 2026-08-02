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
const DEPLOY = join(REPO, 'docs', 'site', 'deploy.sh');

let root: string;
let site: string;
let bin: string;

function write(relative: string, body: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function git(...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  expect(result.status, result.stderr).toBe(0);
}

function stub(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Stands in for the astro build: writes the shape a real build emits, so the
// upload walk is exercised against hashed bundles, Pagefind shards and pages.
function stubBuild(files: readonly string[]): void {
  const lines = files.map((file) => {
    const target = `"$SITE/dist/${file}"`;
    return `mkdir -p "$(dirname ${target})"\nprintf 'body' > ${target}`;
  });
  stub(
    'node',
    ['#!/usr/bin/env bash', 'set -eu', `SITE=${JSON.stringify(site)}`, ...lines, 'exit 0'].join(
      '\n',
    ),
  );
}

// Mirrors the shapes a real Starlight build emits. `pf_filter` is here because
// Pagefind writes one whenever the index has filters, which Starlight's always
// does — omitting it from this fixture is what let an unpublishable site pass.
const BUILT = [
  'index.html',
  'getting-started/install/index.html',
  '_astro/app.aYS1OYVv.css',
  '_astro/page.LAbJoB63.js',
  'pagefind/pagefind.js',
  'pagefind/index/en_c83d5de.pf_index',
  'pagefind/filter/en_52192b3.pf_filter',
  'pagefind/fragment/en_9e45372.pf_fragment',
  'pagefind/pagefind.en_77851b82ae.pf_meta',
  'pagefind/wasm.en.pagefind',
  'favicon.svg',
  'sitemap-0.xml',
];

// Records every argv it is handed and answers the three shapes deploy.sh uses:
// an upload, the stamp read-back, and a status probe.
function stubCurl(): void {
  stub(
    'curl',
    [
      '#!/usr/bin/env bash',
      'set -eu',
      `LOG=${JSON.stringify(join(root, '.uploads'))}`,
      `ARGV=${JSON.stringify(join(root, '.argv'))}`,
      `LIVE=${JSON.stringify(join(root, '.live-sha'))}`,
      `REMOTE=${JSON.stringify(join(root, '.remote-keys'))}`,
      `DEL=${JSON.stringify(join(root, '.deleted'))}`,
      'printf "%s\\n" "$*" >> "$ARGV"',
      'is_put=; is_code=; is_delete=',
      'for a in "$@"; do',
      '  case "$a" in PUT) is_put=1 ;; DELETE) is_delete=1 ;; -w) is_code=1 ;; esac',
      'done',
      'eval "url=\\${$#}"',
      'if [ -n "$is_delete" ]; then printf "%s\\n" "${url##*/api/site/}" >> "$DEL"; exit 0; fi',
      'case "$url" in *api/site-list/*) cat "$REMOTE" 2>/dev/null || printf "{\\"keys\\":[]}"; exit 0 ;; esac',
      'if [ -n "$is_put" ]; then printf "%s\\n" "${url##*/api/site/docs/}" >> "$LOG"; exit 0; fi',
      'if [ -n "$is_code" ]; then printf "200"; exit 0; fi',
      'if [ -f "$LIVE" ]; then cat "$LIVE"; fi',
      'exit 0',
    ].join('\n'),
  );
}

// Answers 400 for one upload, the way the worker does for a path it rejects.
function stubCurlRejecting(fragment: string): void {
  stub(
    'curl',
    [
      '#!/usr/bin/env bash',
      'set -eu',
      `LOG=${JSON.stringify(join(root, '.uploads'))}`,
      `LIVE=${JSON.stringify(join(root, '.live-sha'))}`,
      'is_put=; is_code=',
      'for a in "$@"; do',
      '  case "$a" in PUT) is_put=1 ;; -w) is_code=1 ;; esac',
      'done',
      'eval "url=\\${$#}"',
      'if [ -n "$is_put" ]; then',
      `  case "$url" in *${fragment}*) printf 'invalid path\\n'; exit 22 ;; esac`,
      '  printf "%s\\n" "${url##*/api/site/docs/}" >> "$LOG"; exit 0',
      'fi',
      'if [ -n "$is_code" ]; then printf "200"; exit 0; fi',
      'if [ -f "$LIVE" ]; then cat "$LIVE"; fi',
      'exit 0',
    ].join('\n'),
  );
}

function deploy(env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [join(site, 'deploy.sh')], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: root,
      AGENTKIT_SITE_TOKEN_FILE: join(root, 'token'),
      AGENTKIT_SITE_ENDPOINT: 'https://site-api.example.test',
      AGENTKIT_SITE_URL: 'https://site.example.test',
      ...env,
    },
  });
}

function remoteKeys(keys: string[]): void {
  writeFileSync(join(root, '.remote-keys'), JSON.stringify({ ok: true, keys }));
}

function deleted(): string[] {
  const path = join(root, '.deleted');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
}

function uploads(): string[] {
  const path = join(root, '.uploads');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
}

function headSha(): string {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--short=8', 'HEAD'], {
    encoding: 'utf-8',
  });
  return result.stdout.trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentkit-docs-deploy-'));
  site = join(root, 'docs', 'site');
  bin = join(root, '.bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(site, { recursive: true });
  cpSync(DEPLOY, join(site, 'deploy.sh'));
  chmodSync(join(site, 'deploy.sh'), 0o755);
  // The real script builds archived versions from git tags; these tests cover
  // the deploy contract around it, so a stub stands in.
  writeFileSync(join(site, 'build-archives.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(site, 'build-archives.sh'), 0o755);
  write('token', 'site-secret');
  write('.gitignore', 'dist/\n.bin/\n.uploads\n.argv\n.live-sha\n.remote-keys\n.deleted\ntoken\n');
  stubCurl();
  stubBuild(BUILT);
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'base');
  writeFileSync(join(root, '.live-sha'), headSha());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the docs deploy refuses before it can mislead', () => {
  test('a missing site token stops the deploy', () => {
    rmSync(join(root, 'token'));
    const result = deploy();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('site token missing');
    expect(uploads()).toEqual([]);
  });

  test('a dirty tree stops the deploy, because the stamp would verify against itself', () => {
    write('docs/site/src/stray.md', 'uncommitted');
    const result = deploy();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to publish a dirty build');
    expect(uploads()).toEqual([]);
  });

  test('an explicit override allows a dirty deploy', () => {
    write('docs/site/src/stray.md', 'uncommitted');
    writeFileSync(join(root, '.live-sha'), `${headSha()}-dirty`);
    const result = deploy({ AGENTKIT_ALLOW_DIRTY_DEPLOY: '1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('-dirty');
  });

  // A declared archived version that no longer builds must fail the publish
  // naming it — never quietly drop a version from the live site.
  test('a failing archive build fails the deploy', () => {
    writeFileSync(
      join(site, 'build-archives.sh'),
      '#!/usr/bin/env bash\necho "build-archives: the v9.9.9 docs no longer build" >&2\nexit 1\n',
    );
    chmodSync(join(site, 'build-archives.sh'), 0o755);
    // Committed, or the dirty-build refusal fires before the archive step.
    git('add', '-A');
    git('commit', '-qm', 'failing archives');

    const result = deploy();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('v9.9.9');
    expect(uploads()).toEqual([]);
  });

  test('an empty build is not reported as a successful deploy', () => {
    stubBuild([]);
    const result = deploy();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no built site');
  });

  // The bounded read-back retries six times at two-second intervals, so this
  // case deliberately outlives the default per-test timeout.
  test('a live stamp that does not match the build fails the deploy', () => {
    writeFileSync(join(root, '.live-sha'), 'deadbeef');
    const result = deploy();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected');
  }, 30000);
});

describe('the docs deploy uploads in a recoverable order', () => {
  test('every built file is uploaded', () => {
    const result = deploy();

    expect(result.status).toBe(0);
    expect(uploads().sort()).toEqual([...BUILT, 'build-sha.txt'].sort());
  });

  test('assets land before documents, so a half-finished walk leaves no broken page', () => {
    deploy();
    // The stamp is an asset by extension but is deliberately uploaded last, so
    // it is excluded here; its position has its own test.
    const order = uploads().filter((file) => file !== 'build-sha.txt');
    const lastAsset = Math.max(...order.map((file, i) => (file.endsWith('.html') ? -1 : i)));
    const firstDocument = order.findIndex((file) => file.endsWith('.html'));

    expect(firstDocument).toBeGreaterThan(-1);
    expect(lastAsset).toBeLessThan(firstDocument);
  });

  test('the stamp is uploaded last, so it never names an unfinished version', () => {
    deploy();
    const order = uploads();

    expect(order[order.length - 1]).toBe('build-sha.txt');
  });

  test('the stamp carries the commit the build came from', () => {
    deploy();

    expect(readFileSync(join(site, 'dist', 'build-sha.txt'), 'utf-8').trim()).toBe(headSha());
  });
});

describe('the docs deploy keeps the token off the command line', () => {
  test('no argv holds the token, and the credential is passed by config file', () => {
    const result = deploy();
    const argv = readFileSync(join(root, '.argv'), 'utf-8');

    expect(result.status).toBe(0);
    expect(argv).not.toContain('site-secret');
    expect(argv).toContain('--config');
  });
});

describe('a rejected upload stops the deploy', () => {
  // Without this, one 400 in the middle of the walk left the stamp published over
  // a site missing an asset, and the read-back still matched — "verified live"
  // printed over a broken site.
  test('an asset the endpoint rejects aborts before the stamp is uploaded', () => {
    stubCurlRejecting('pf_filter');
    const result = deploy();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAILED');
    expect(uploads()).not.toContain('build-sha.txt');
    expect(result.stdout).not.toContain('verified live');
  });

  test('a rejected document aborts before the stamp is uploaded', () => {
    stubCurlRejecting('install/index.html');
    const result = deploy();

    expect(result.status).toBe(1);
    expect(uploads()).not.toContain('build-sha.txt');
  });
});

describe('a page removed from the build stops being served', () => {
  // Uploading never removed anything, so a deleted page kept answering 200 with
  // nothing reporting it. Ten migration redirects were deleted by hand for exactly
  // that reason before this existed.
  test('an object no longer in the build is pruned and reported', () => {
    remoteKeys([...BUILT.map((f) => `docs/${f}`), 'docs/retired/index.html', 'docs/build-sha.txt']);
    const result = deploy();

    expect(result.status, result.stderr).toBe(0);
    expect(deleted()).toEqual(['docs/retired/index.html']);
    expect(result.stdout).toContain('pruned: docs/retired/index.html');
  });

  test('nothing to prune is stated rather than implied', () => {
    remoteKeys([...BUILT.map((f) => `docs/${f}`), 'docs/build-sha.txt']);
    const result = deploy();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to prune');
    expect(deleted()).toEqual([]);
  });

  // Deleting the wrong object is worse than keeping a stale one, so an implausible
  // diff has to stop the deploy rather than act on it.
  test('a diff that would remove most of the site refuses instead of pruning', () => {
    remoteKeys([
      ...BUILT.map((f) => `docs/${f}`),
      ...Array.from({ length: 40 }, (_, i) => `docs/retired-${i}/index.html`),
    ]);
    const result = deploy();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to prune');
    expect(deleted()).toEqual([]);
  });

  test('a listing that cannot be read stops the deploy rather than pruning blind', () => {
    stub(
      'curl',
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `LIVE=${JSON.stringify(join(root, '.live-sha'))}`,
        'for a in "$@"; do case "$a" in *api/site-list/*) exit 22 ;; esac; done',
        'eval "url=\\${$#}"',
        // the stamp read-back runs before the prune, so it has to succeed or the
        // deploy never reaches the step under test
        'case "$url" in *build-sha.txt) cat "$LIVE"; exit 0 ;; esac',
        'printf "200"',
        'exit 0',
      ].join('\n'),
    );
    const result = deploy();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not list');
  });
});

// Archives build from immutable tags, so rebuilding every one on every deploy is
// pure waste. Reusing them means their objects are live but absent from dist/,
// which is exactly the shape the prune treats as deleted.
describe('a reused archive survives the prune that removes deleted pages', () => {
  function stubArchives(slugs: readonly string[]): void {
    writeFileSync(
      join(site, 'build-archives.sh'),
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `printf '%s\\n' ${slugs.map((slug) => JSON.stringify(slug)).join(' ')} > dist/.reused-archives`,
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(site, 'build-archives.sh'), 0o755);
    // Committed because deploy.sh refuses a dirty tree, and the live sha follows
    // because the read-back compares against the commit it just published.
    git('add', '-A');
    git('commit', '-qm', 'archive stub');
    writeFileSync(join(root, '.live-sha'), headSha());
  }

  const live = (extra: readonly string[]) => [
    ...BUILT.map((file) => `docs/${file}`),
    ...extra,
    'docs/build-sha.txt',
  ];

  test('its live objects are kept even though the build did not produce them', () => {
    stubArchives(['0.5.3']);
    remoteKeys(live(['docs/0.5.3/index.html', 'docs/0.5.3/archive-stamp.txt']));
    const result = deploy();

    expect(result.status, result.stderr).toBe(0);
    expect(deleted()).toEqual([]);
    expect(result.stdout).toContain('kept 1 reused archive');
  });

  // The other half of the contract: sparing reused slugs must not spare a version
  // that left the selection, or dropped archives would be published forever.
  test('an archive that left the selection still prunes', () => {
    stubArchives(['0.5.3']);
    remoteKeys(live(['docs/0.5.3/index.html', 'docs/0.4.5/index.html']));
    const result = deploy();

    expect(result.status, result.stderr).toBe(0);
    expect(deleted()).toEqual(['docs/0.4.5/index.html']);
  });

  // The slug reaches a regex, where an unescaped dot matches any character.
  test('a reused slug spares itself and not a lookalike key', () => {
    stubArchives(['0.5.3']);
    remoteKeys(live(['docs/0.5.3/index.html', 'docs/0X5X3/index.html']));
    const result = deploy();

    expect(result.status, result.stderr).toBe(0);
    expect(deleted()).toEqual(['docs/0X5X3/index.html']);
  });

  // Sparing has to happen before the >50% refusal. Measured after, a handful of
  // reused archives reads as a mass deletion and stops every deploy.
  test('reused objects are not counted by the refusal that guards mass deletion', () => {
    stubArchives(['0.5.3']);
    remoteKeys(
      live(Array.from({ length: 40 }, (_, index) => `docs/0.5.3/page-${index}/index.html`)),
    );
    const result = deploy();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('nothing to prune');
    expect(result.stderr).not.toContain('refusing to prune');
  });

  test('the reuse list is a build artefact and is never uploaded', () => {
    stubArchives(['0.5.3']);
    remoteKeys(live(['docs/0.5.3/index.html']));
    const result = deploy();

    expect(result.status, result.stderr).toBe(0);
    expect(uploads()).not.toContain('.reused-archives');
    expect(uploads().filter((key) => key.includes('reused-archives'))).toEqual([]);
  });

  test('no reuse leaves the prune exactly as it was', () => {
    remoteKeys(live(['docs/retired/index.html']));
    const result = deploy();

    expect(result.status, result.stderr).toBe(0);
    expect(deleted()).toEqual(['docs/retired/index.html']);
    expect(result.stdout).not.toContain('reused archive');
  });
});
