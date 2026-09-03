import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from './browser-launch.ts';

// More than a raw pipe's 64 KB buffer, so the capture is exercised at a volume
// a launch going wrong can actually reach rather than a token line or two.
const NOISE_LINES = 1_400;
const NOISE_LINE = 'stub-noise 0123456789012345678901234567890123456789012345678901234567890123456789';
const FLOOD_BYTES = NOISE_LINES * (NOISE_LINE.length + 6);

const scratch = mkdtempSync(join(tmpdir(), 'agentkit-launch-'));
let debugPort = 0;
let server: ReturnType<typeof Bun.serve> | undefined;

function pageTarget(): string {
  return `ws://127.0.0.1:${debugPort}/devtools/page/stub`;
}

// The launcher's contract stops at the devtools endpoint, so the stub only has
// to answer /json/list the way a browser does — no real CDP socket is needed.
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/json/list') return new Response('no', { status: 404 });
      return Response.json([{ type: 'page', webSocketDebuggerUrl: pageTarget() }]);
    },
  });
  debugPort = server.port;
});

afterAll(() => {
  server?.stop(true);
  rmSync(scratch, { force: true, recursive: true });
});

interface StubOptions {
  flood?: boolean;
  publishOnAttempt?: number;
  counter?: string;
}

function stub(name: string, options: StubOptions = {}): string {
  const path = join(scratch, `${name}.sh`);
  const counter = options.counter ?? join(scratch, `${name}.count`);
  const flood = options.flood
    ? `i=0\nwhile [ \$i -lt ${NOISE_LINES} ]; do\n  echo "${NOISE_LINE} \$i" >&2\n  i=\$((i + 1))\ndone\n`
    : `echo "${NOISE_LINE} solitary" >&2\n`;
  const publish = options.publishOnAttempt === undefined
    ? ''
    : `if [ "\$attempt" -ge ${options.publishOnAttempt} ]; then\n`
      + `  printf '%s\\n%s\\n' "${debugPort}" "/devtools/browser/stub" > "\$profile/DevToolsActivePort"\n`
      + `fi\n`;
  writeFileSync(
    path,
    `#!/bin/sh\n`
      + `profile=""\n`
      + `for arg in "\$@"; do\n`
      + `  case "\$arg" in --user-data-dir=*) profile=\${arg#--user-data-dir=} ;; esac\n`
      + `done\n`
      + `attempt=\$(( \$(cat "${counter}" 2>/dev/null || echo 0) + 1 ))\n`
      + `echo "\$attempt" > "${counter}"\n`
      + flood
      + publish
      // exec so a kill reaches this process: a lingering child would hold the
      // stderr pipe open and the launcher would wait on an EOF that never came.
      + `exec sleep 60\n`,
  );
  chmodSync(path, 0o755);
  if (existsSync(counter)) rmSync(counter);
  return path;
}

function attempts(name: string): number {
  const counter = join(scratch, `${name}.count`);
  return existsSync(counter) ? Number(readFileSync(counter, 'utf-8').trim()) : 0;
}

describe('launching a browser for the devtools endpoint', () => {
  test('a browser flooding stderr is captured to its last line, and still launches', async () => {
    expect(FLOOD_BYTES).toBeGreaterThan(65_536);
    const launch = await launchBrowser({
      binary: stub('flooder', { flood: true, publishOnAttempt: 1 }),
      attemptMs: 15_000,
      attempts: 1,
    });
    try {
      expect(launch.endpoint).toBe(pageTarget());
      expect(launch.stderrTail(200)).toContain(`${NOISE_LINE} ${NOISE_LINES - 1}`);
      // Bounded, or a chatty browser would grow the harness without limit.
      expect(launch.stderrTail(40).split('\n')).toHaveLength(40);
      expect(launch.stderrTail(40)).not.toContain(`${NOISE_LINE} 0\n`);
    } finally {
      launch.close();
    }
  }, 60_000);

  test('a launch that times out reports the browser stderr it swallowed before', async () => {
    const promise = launchBrowser({
      binary: stub('silent', { flood: true }),
      attemptMs: 1_500,
      attempts: 1,
    });
    await expect(promise).rejects.toThrow(/last 40 lines of browser stderr/);
    await promise.catch((error: Error) => {
      expect(error.message).toContain(`${NOISE_LINE} ${NOISE_LINES - 1}`);
      expect(error.message).toContain('port file never appeared');
    });
  }, 60_000);

  test('a stillborn first launch is retried on a fresh profile', async () => {
    const launch = await launchBrowser({
      binary: stub('second-time-lucky', { publishOnAttempt: 2 }),
      attemptMs: 1_500,
      attempts: 2,
    });
    try {
      expect(attempts('second-time-lucky')).toBe(2);
      expect(launch.endpoint).toBe(pageTarget());
    } finally {
      launch.close();
    }
  }, 60_000);

  test('a second failure surfaces both attempts and the ceiling it spent', async () => {
    const promise = launchBrowser({
      binary: stub('never', {}),
      attemptMs: 1_000,
      attempts: 2,
    });
    await expect(promise).rejects.toThrow(/after 2 attempts of 1000ms \(2000ms ceiling\)/);
    await promise.catch((error: Error) => {
      expect(error.message).toContain('attempt 1/2');
      expect(error.message).toContain('attempt 2/2');
    });
    expect(attempts('never')).toBe(2);
  }, 60_000);
});
