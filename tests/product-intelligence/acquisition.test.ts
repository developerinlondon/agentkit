import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertHostAllowed,
  expandIPv6,
  isBlockedAddress,
  isBlockedIPv4,
  isBlockedIPv6,
  safeFetch,
} from '../../skills/product-intelligence/scripts/net.ts';
import {
  advertoolsArgs,
  repomixArgs,
  runnerPrefix,
  targetSlug,
} from '../../skills/product-intelligence/scripts/acquire.ts';

const repoRoot = dirname(dirname(import.meta.dir));
const acquireScript = join(repoRoot, 'skills', 'product-intelligence', 'scripts', 'acquire.ts');

const savedEnv = { allow: '', path: '' };
let scratch = '';

beforeEach(() => {
  savedEnv.allow = process.env.SAFE_FETCH_ALLOW_HOSTS ?? '';
  savedEnv.path = process.env.PATH ?? '';
  scratch = mkdtempSync(join(tmpdir(), 'agentkit-acquire-'));
});

afterEach(() => {
  process.env.SAFE_FETCH_ALLOW_HOSTS = savedEnv.allow;
  process.env.PATH = savedEnv.path;
  rmSync(scratch, { force: true, recursive: true });
});

describe('address classifier', () => {
  const blockedV4 = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.10',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
  ];
  const allowedV4 = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '198.17.0.1'];
  const blockedV6 = [
    '::',
    '::1',
    'fc00::1',
    'fdab::9',
    'fe80::1',
    'ff02::1',
    '::ffff:1.2.3.4',
    '::ffff:10.0.0.1',
    '::7f00:1',
    '64:ff9b::102:304',
    '2002::1',
    '2001:0:abcd::1',
    '2001:db8::1',
  ];
  const allowedV6 = ['2606:4700:4700::1111', '2a00:1450:4009:80f::200e', '2001:4860:4860::8888'];

  test.each(blockedV4)('blocks IPv4 %s', (ip) => expect(isBlockedIPv4(ip)).toBe(true));
  test.each(allowedV4)('allows public IPv4 %s', (ip) => expect(isBlockedIPv4(ip)).toBe(false));
  test.each(blockedV6)('blocks IPv6 %s', (ip) => expect(isBlockedIPv6(ip)).toBe(true));
  test.each(allowedV6)('allows public IPv6 %s', (ip) => expect(isBlockedIPv6(ip)).toBe(false));

  test('unparseable addresses fail closed', () => {
    expect(isBlockedIPv4('1.2.3')).toBe(true);
    expect(isBlockedIPv4('1.2.3.999')).toBe(true);
    expect(isBlockedIPv6('1::2::3')).toBe(true);
    expect(isBlockedIPv6('g::1')).toBe(true);
    expect(isBlockedAddress('not-an-ip:at-all')).toBe(true);
  });

  test('expandIPv6 handles compression and embedded IPv4', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIPv6('2001:db8::8:800:200c:417a')).toEqual([
      0x2001,
      0x0db8,
      0,
      0,
      0x8,
      0x800,
      0x200c,
      0x417a,
    ]);
  });
});

describe('assertHostAllowed', () => {
  test('refuses localhost and literal non-public addresses without an override', async () => {
    await expect(assertHostAllowed('localhost')).rejects.toThrow('loopback');
    await expect(assertHostAllowed('sub.localhost')).rejects.toThrow('loopback');
    await expect(assertHostAllowed('10.0.0.1')).rejects.toThrow('non-public');
    await expect(assertHostAllowed('[::1]')).rejects.toThrow('non-public');
  });

  test('allows literal public addresses without DNS', async () => {
    await expect(assertHostAllowed('1.1.1.1')).resolves.toBeUndefined();
  });

  test('override is exact-hostname only', async () => {
    process.env.SAFE_FETCH_ALLOW_HOSTS = '127.0.0.1';
    await expect(assertHostAllowed('127.0.0.1')).resolves.toBeUndefined();
    await expect(assertHostAllowed('127.0.0.2')).rejects.toThrow('non-public');
  });
});

describe('safeFetch', () => {
  test('fail-closed by default, per-hop checks, redirect cap, body cap', async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/') return new Response('hello');
        if (path === '/to-private') return Response.redirect('http://10.0.0.1/', 302);
        if (path === '/big') return new Response(big);
        const bounce = path.match(/^\/r(\d+)$/);
        if (bounce) return Response.redirect(`http://127.0.0.1:${server.port}/r${Number(bounce[1]) + 1}`, 302);
        return new Response('miss', { status: 404 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      // The whole point: loopback is refused unless explicitly allowed.
      await expect(safeFetch(`${base}/`)).rejects.toThrow('non-public');

      process.env.SAFE_FETCH_ALLOW_HOSTS = '127.0.0.1';
      const ok = await safeFetch(`${base}/`);
      expect(ok.status).toBe(200);
      expect(new TextDecoder().decode(ok.body)).toBe('hello');
      expect(ok.hops).toEqual([`${base}/`]);

      // The allowlist covers the first hop only — the redirect target is
      // still classified, which is what makes the check per-hop.
      await expect(safeFetch(`${base}/to-private`)).rejects.toThrow('non-public');
      await expect(safeFetch(`${base}/r0`)).rejects.toThrow('redirects');
      await expect(safeFetch(`${base}/big`)).rejects.toThrow('exceeds');
      await expect(safeFetch(`ftp://127.0.0.1/x`)).rejects.toThrow('http(s)');
    } finally {
      server.stop(true);
    }
  });
});

describe('hardened argv builders', () => {
  test('repomix accepts remote forms and refuses anything path-like', () => {
    expect(repomixArgs('owner/repo', 'out.json')).toEqual([
      'repomix',
      '--remote',
      'owner/repo',
      '--style',
      'json',
      '--include',
      'README*,readme*,docs/**,doc/**,CHANGELOG*,CHANGES*,*.md',
      '-o',
      'out.json',
    ]);
    expect(repomixArgs('https://github.com/owner/repo', 'out.json')[1]).toBe('--remote');
    for (const bad of ['./repo', '../repo', '/tmp/repo', '-o', 'owner/repo --remote-trust-config', 'owner']) {
      expect(() => repomixArgs(bad, 'out.json')).toThrow('refusing repomix target');
    }
  });

  test('advertools crawl is bounded, jl-only, and parseable by its argparse CLI', () => {
    // Exact argv: --follow-links takes a 0/1 VALUE — a bare flag makes
    // argparse eat --custom-settings and abort the crawl.
    expect(advertoolsArgs('https://example.com', 'crawl.jl')).toEqual([
      'advertools',
      'crawl',
      'https://example.com/',
      'crawl.jl',
      '--follow-links',
      '1',
      '--custom-settings',
      'DEPTH_LIMIT=3',
      'CLOSESPIDER_PAGECOUNT=200',
    ]);
    expect(() => advertoolsArgs('ftp://example.com', 'crawl.jl')).toThrow('http(s)');
    expect(() => advertoolsArgs('https://example.com', 'crawl.csv')).toThrow('.jl');
  });

  test('runner prefix is mandatory on Linux and absent elsewhere', () => {
    expect(runnerPrefix('darwin')).toEqual([]);
    process.env.PATH = scratch;
    expect(() => runnerPrefix('linux')).toThrow('agentkit-run');
    fakeExecutable('agentkit-run', 'exit 0');
    expect(runnerPrefix('linux')).toEqual(['agentkit-run', '--profile', 'default', '--']);
  });
});

function fakeExecutable(name: string, body: string): void {
  const path = join(scratch, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function fakePlatformTool(tool: 'advertools' | 'repomix'): string {
  const invocationPath = join(scratch, 'tool-argv');
  const body = `printf '%s\\n' "$*" > '${invocationPath}'`;
  fakeExecutable(process.platform === 'linux' ? 'agentkit-run' : tool, body);
  return invocationPath;
}

function expectedPlatformInvocation(tool: 'advertools' | 'repomix', args: string): string {
  return process.platform === 'linux' ? `--profile default -- ${tool} ${args}` : args;
}

describe('acquire.ts CLI', () => {
  function runCli(...args: string[]) {
    const result = Bun.spawnSync([process.execPath, acquireScript, ...args], {
      env: { ...process.env, PATH: `${scratch}:/usr/bin:/bin` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: result.exitCode,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
    };
  }

  test('repo lane follows the platform runner contract and stamps provenance', () => {
    const invocationPath = fakePlatformTool('repomix');
    const outDir = join(scratch, 'out');
    const result = runCli('repo', 'owner/repo', '--out', outDir);

    expect(result.code, result.err).toBe(0);
    expect(readFileSync(invocationPath, 'utf-8').trim()).toBe(
      expectedPlatformInvocation(
        'repomix',
        '--remote owner/repo --style json --include '
          + `README*,readme*,docs/**,doc/**,CHANGELOG*,CHANGES*,*.md -o ${join(outDir, 'repo-owner_repo.json')}`,
      ),
    );
    const entries = JSON.parse(readFileSync(join(outDir, 'acquisition.json'), 'utf-8'));
    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe('repomix --remote');
    expect(entries[0].target).toBe('owner/repo');
    expect(entries[0].retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(readFileSync(join(outDir, 'invocations.log'), 'utf-8')).toContain('"repomix"');
  });

  test('site lane emits the platform-correct crawl invocation', () => {
    process.env.SAFE_FETCH_ALLOW_HOSTS = 'example.com'; // keep the test off DNS
    const invocationPath = fakePlatformTool('advertools');
    const outDir = join(scratch, 'out');
    const result = runCli('site', 'https://example.com', '--out', outDir);
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(invocationPath, 'utf-8').trim()).toBe(
      expectedPlatformInvocation(
        'advertools',
        'crawl https://example.com/ '
          + `${join(outDir, 'crawl-example.com.jl')} --follow-links 1 --custom-settings DEPTH_LIMIT=3 CLOSESPIDER_PAGECOUNT=200`,
      ),
    );
  });

  test('targetSlug strips scheme and .git and keeps targets distinct', () => {
    expect(targetSlug('owner/repo')).toBe('owner_repo');
    expect(targetSlug('https://gitlab.com/agentkit/agentkit-pages.git')).toBe('gitlab.com_agentkit_agentkit-pages');
    expect(targetSlug('https://gitlab.com/a/b')).not.toBe(targetSlug('https://gitlab.com/a/c'));
  });

  test('two repo origins acquired into one directory keep separate packs', () => {
    // The bug this pins: a fixed repo.json let the second origin's pack
    // silently clobber the first during a real multi-origin run.
    process.env.SAFE_FETCH_ALLOW_HOSTS = 'gitlab.com';
    const invocationPath = join(scratch, 'tool-log');
    const tool = process.platform === 'linux' ? 'agentkit-run' : 'repomix';
    fakeExecutable(tool, `printf '%s\\n' "$*" >> '${invocationPath}'`);
    const outDir = join(scratch, 'out');
    expect(runCli('repo', 'owner/repo', '--out', outDir).code).toBe(0);
    expect(runCli('repo', 'https://gitlab.com/other/pages', '--out', outDir).code).toBe(0);
    const log = readFileSync(invocationPath, 'utf-8');
    expect(log).toContain('repo-owner_repo.json');
    expect(log).toContain('repo-gitlab.com_other_pages.json');
  });

  test('repo lane refuses a non-public host in URL form', () => {
    fakeExecutable('agentkit-run', `touch '${scratch}/runner-ran'; exit 0`);
    for (const bad of ['https://10.0.0.1/o/r', 'https://169.254.169.254/o/r', 'https://localhost/o/r']) {
      const result = runCli('repo', bad, '--out', join(scratch, 'out'));
      expect(result.code, bad).toBe(1);
      expect(result.err).toMatch(/non-public|loopback/);
    }
    expect(() => readFileSync(join(scratch, 'runner-ran'))).toThrow();
  });

  test('repo lane refuses a local path before any tool runs', () => {
    fakeExecutable('agentkit-run', `touch '${scratch}/runner-ran'; exit 0`);
    const result = runCli('repo', './some/clone', '--out', join(scratch, 'out'));
    expect(result.code).toBe(1);
    expect(result.err).toContain('refusing repomix target');
    expect(() => readFileSync(join(scratch, 'runner-ran'))).toThrow();
  });

  test('gh lane writes per-target evidence files so two origins cannot clobber each other', () => {
    fakeExecutable('gh', `printf '{"lane":"%s"}' "$2"`);
    const outDir = join(scratch, 'out');
    const result = runCli('gh', 'owner/repo', '--out', outDir);
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(join(outDir, 'gh-owner_repo-meta.json'), 'utf-8')).toContain('repos/owner/repo');
    expect(readFileSync(join(outDir, 'gh-owner_repo-releases.json'), 'utf-8')).toContain('releases');
    const entries = JSON.parse(readFileSync(join(outDir, 'acquisition.json'), 'utf-8'));
    expect(entries[0].tool).toBe('gh api');
  });

  test('rejects unknown lanes and malformed usage', () => {
    expect(runCli('teleport', 'x', '--out', join(scratch, 'out')).code).toBe(2);
    expect(runCli('repo', 'owner/repo').code).toBe(2);
  });
});
