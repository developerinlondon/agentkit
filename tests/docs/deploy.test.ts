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
      'printf "%s\\n" "$*" >> "$ARGV"',
      'is_put=; is_code=',
      'for a in "$@"; do',
      '  case "$a" in PUT) is_put=1 ;; -w) is_code=1 ;; esac',
      'done',
      'eval "url=\\${$#}"',
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
      AGENTKIT_PAGES_ENDPOINT: 'https://pages.example.test',
      AGENTKIT_SITE_URL: 'https://site.example.test',
      ...env,
    },
  });
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
  write('token', 'site-secret');
  write('.gitignore', 'dist/\n.bin/\n.uploads\n.argv\n.live-sha\ntoken\n');
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
